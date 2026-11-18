package controllers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/invites"
)

type LeagueInvites struct {
	Auth   *auth.Guard
	Config *invites.Config
}

const (
	inviteIssue  = "invite.issue"
	inviteRevoke = "invite.revoke"
	invitePeriod = 168 * time.Hour
	inviteFields = "id, league_id, issued_at, expires_at, revoked_at, key_version, credential_hash, version::text"
)

type invite struct {
	ID        string     `json:"id"`
	LeagueID  string     `json:"league_id"`
	IssuedAt  time.Time  `json:"issued_at"`
	ExpiresAt time.Time  `json:"expires_at"`
	RevokedAt *time.Time `json:"revoked_at"`
	Version   string     `json:"version"`
	Status    string     `json:"status"`
	Code      string     `json:"code,omitempty"`
	JoinURL   string     `json:"join_url,omitempty"`

	keyVersion int
	hash       string
}

func (i *invite) scan(row *sql.Row) error {
	return row.Scan(&i.ID, &i.LeagueID, &i.IssuedAt, &i.ExpiresAt, &i.RevokedAt, &i.keyVersion, &i.hash, &i.Version)
}

func (i *invite) state(now time.Time) string {
	switch {
	case i.RevokedAt != nil:
		return "revoked"
	case !now.Before(i.ExpiresAt):
		return "expired"
	default:
		return "active"
	}
}

func (li *LeagueInvites) render(ctx context.Context, tx *sql.Tx, i *invite, group string) error {
	var now time.Time
	if err := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return err
	}
	i.IssuedAt = i.IssuedAt.UTC()
	i.ExpiresAt = i.ExpiresAt.UTC()
	if i.RevokedAt != nil {
		utc := i.RevokedAt.UTC()
		i.RevokedAt = &utc
	}
	i.Status = i.state(now)
	if i.Status == "active" {
		var ok bool
		i.Code, i.JoinURL, ok = li.Config.Display(i.LeagueID, i.ID, i.keyVersion, i.hash, group)
		if !ok {
			return errors.New("invite key unavailable")
		}
	}
	return nil
}

func manageInvites(role string) bool { return role == "owner" || role == "admin" }

func inviteForbidden(c *gin.Context) {
	httpx.Error(c, 403, "FORBIDDEN", "招待を管理する権限がありません", nil)
}

func setInviteScope(ctx context.Context, tx *sql.Tx, leagueID, actor string) error {
	_, err := tx.ExecContext(ctx, `SELECT set_config('mjstats.invite_league_id',$1,true),
		set_config('mjstats.league_actor_id',$2,true)`, leagueID, actor)
	return err
}

func (li *LeagueInvites) Current() gin.HandlerFunc {
	lc := &LeagueController{DB: li.Auth.DB}
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		if !manageInvites(l.MyRole) {
			inviteForbidden(c)
			return nil
		}
		if _, ok := queryParams(c); !ok {
			return nil
		}
		if li.Config == nil || setInviteScope(ctx, tx, l.ID, c.GetString("participant_id")) != nil {
			httpx.Unavailable(c)
			return nil
		}
		var i invite
		err := i.scan(tx.QueryRowContext(ctx, `SELECT `+inviteFields+`
			FROM public.league_invites WHERE league_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, l.ID))
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return gin.H{"invite": nil}
		case err != nil || li.render(ctx, tx, &i, l.GroupNumber) != nil:
			httpx.Unavailable(c)
			return nil
		case i.Status != "active":
			return gin.H{"invite": nil}
		default:
			return gin.H{"invite": i}
		}
	})
}

type inviteCommand struct {
	operation string
	requestID string
	target    string
	version   string
}

func (li *LeagueInvites) Issue(c *gin.Context) {
	var input struct {
		ClientRequestID string `json:"client_request_id"`
	}
	if httpx.Decode(c, &input) {
		li.change(c, inviteCommand{operation: inviteIssue, requestID: input.ClientRequestID})
	}
}

func (li *LeagueInvites) Revoke(c *gin.Context) {
	var input struct {
		ClientRequestID string `json:"client_request_id"`
		Version         string `json:"version"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	version, err := strconv.ParseInt(input.Version, 10, 64)
	if err != nil || version <= 0 || strconv.FormatInt(version, 10) != input.Version {
		invalidQuery(c, "version")
		return
	}
	target := strings.ToLower(c.Param("id"))
	if !uuidPattern.MatchString(target) {
		invalidQuery(c, "id")
		return
	}
	li.change(c, inviteCommand{operation: inviteRevoke, requestID: input.ClientRequestID, target: target, version: input.Version})
}

// Writes share the league lock with future membership changes. Authority is
// checked before taking the lock, then reread under it before any invite work.
func lockInviteLeague(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, actor string) (string, bool) {
	var role string
	err := tx.QueryRowContext(ctx, `SELECT m.role FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id
		WHERE m.league_id=$1 AND m.user_id=$2 AND m.status='active' AND m.participant_kind='registered'
		AND l.group_number IS NOT NULL`, leagueID, actor).Scan(&role)
	if !inviteAuthority(c, role, err) {
		return "", false
	}

	var group string
	err = tx.QueryRowContext(ctx, `SELECT group_number FROM public.leagues WHERE id=$1 AND group_number IS NOT NULL FOR UPDATE`,
		leagueID).Scan(&group)
	if !inviteAuthority(c, role, err) {
		return "", false
	}

	var completed bool
	err = tx.QueryRowContext(ctx, `SELECT profile_completed_at IS NOT NULL FROM public.users
		WHERE id=$1 AND auth_id=$2 AND participant_kind='registered' FOR SHARE`, actor, auth.From(c).Subject).Scan(&completed)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 403, "PROFILE_REQUIRED", "本人情報を取得してください", nil)
		return "", false
	case err != nil:
		httpx.Unavailable(c)
		return "", false
	case !completed:
		httpx.Error(c, 403, "PROFILE_INCOMPLETE", "表示名を設定してください", nil)
		return "", false
	}
	err = tx.QueryRowContext(ctx, `SELECT role FROM public.league_members
		WHERE league_id=$1 AND user_id=$2 AND status='active' AND participant_kind='registered' FOR SHARE`,
		leagueID, actor).Scan(&role)
	return group, inviteAuthority(c, role, err)
}

func inviteAuthority(c *gin.Context, role string, err error) bool {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 403, "LEAGUE_ACCESS_DENIED", "このリーグは閲覧できません", nil)
	case err != nil:
		httpx.Unavailable(c)
	case !manageInvites(role):
		inviteForbidden(c)
	default:
		return true
	}
	return false
}

func (li *LeagueInvites) change(c *gin.Context, cmd inviteCommand) {
	leagueID := strings.ToLower(pathLeague(c))
	if !uuidPattern.MatchString(leagueID) {
		invalidQuery(c, "league_id")
		return
	}
	if !uuidPattern.MatchString(cmd.requestID) {
		invalidQuery(c, "client_request_id")
		return
	}
	if _, ok := queryParams(c); !ok {
		return
	}
	cmd.requestID = strings.ToLower(cmd.requestID)
	digest := sha256.Sum256([]byte(cmd.operation + ":v1\x00" + leagueID + "\x00" + cmd.target + "\x00" + cmd.version))
	requestHash := hex.EncodeToString(digest[:])

	tx, ctx, cancel, err := li.Auth.BeginWrite(c)
	if err != nil {
		auth.Reject(c, err)
		return
	}
	defer cancel()
	defer tx.Rollback()
	actor := c.GetString("participant_id")
	group, ok := lockInviteLeague(c, ctx, tx, leagueID, actor)
	if !ok {
		return
	}
	if li.Config == nil || setInviteScope(ctx, tx, leagueID, actor) != nil {
		httpx.Unavailable(c)
		return
	}

	// Lock the operation identity across leagues too. The next statement uses
	// a fresh READ COMMITTED snapshot after the preceding operation finishes.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		cmd.operation+":"+actor+":"+cmd.requestID); err != nil {
		httpx.Unavailable(c)
		return
	}
	replayID, ok := inviteReplay(c, ctx, tx, cmd, leagueID, actor, requestHash)
	if !ok {
		return
	}

	var i invite
	status := http.StatusOK
	switch {
	case replayID != "":
		err = loadInvite(ctx, tx, &i, leagueID, replayID)
	case cmd.operation == inviteIssue:
		status = http.StatusCreated
		err = li.issue(ctx, tx, &i, leagueID, actor)
	default:
		if !revokeInvite(c, ctx, tx, &i, leagueID, cmd) {
			return
		}
	}
	if err == nil && replayID == "" {
		_, err = tx.ExecContext(ctx, `INSERT INTO public.league_events
			(league_id,actor_id,operation,client_request_id,target,version,request_hash,after)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb)`, leagueID, actor, cmd.operation, cmd.requestID, i.ID, i.Version, requestHash)
	}
	if err != nil || li.render(ctx, tx, &i, group) != nil {
		httpx.Unavailable(c)
		return
	}
	if !li.Auth.BeforeCommit(c) {
		httpx.Unauthenticated(c)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(status, gin.H{"invite": i})
}

func inviteReplay(c *gin.Context, ctx context.Context, tx *sql.Tx, cmd inviteCommand, leagueID, actor, hash string) (string, bool) {
	var id, existingHash string
	err := tx.QueryRowContext(ctx, `SELECT invite_id, request_hash FROM public.league_events
		WHERE league_id=$1 AND actor_id=$2 AND operation=$3 AND client_request_id=$4`,
		leagueID, actor, cmd.operation, cmd.requestID).Scan(&id, &existingHash)
	var elsewhere bool
	if errors.Is(err, sql.ErrNoRows) {
		err = tx.QueryRowContext(ctx, `SELECT mjstats_private.invite_request_used_elsewhere($1,$2)`, cmd.operation, cmd.requestID).
			Scan(&elsewhere)
	}
	switch {
	case err != nil:
		httpx.Unavailable(c)
	case elsewhere || (id != "" && existingHash != hash):
		httpx.Error(c, 409, "IDEMPOTENCY_CONFLICT", "同じ操作IDが別の内容で使われています", nil)
	default:
		return id, true
	}
	return "", false
}

func loadInvite(ctx context.Context, tx *sql.Tx, i *invite, leagueID, id string) error {
	return i.scan(tx.QueryRowContext(ctx, `SELECT `+inviteFields+` FROM public.league_invites WHERE league_id=$1 AND id=$2`, leagueID, id))
}

func (li *LeagueInvites) issue(ctx context.Context, tx *sql.Tx, i *invite, leagueID, actor string) error {
	var id string
	var issued time.Time
	if err := tx.QueryRowContext(ctx, `SELECT gen_random_uuid(), clock_timestamp()`).Scan(&id, &issued); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE public.league_invites SET revoked_at=$2,version=version+1
		WHERE league_id=$1 AND revoked_at IS NULL`, leagueID, issued); err != nil {
		return err
	}
	return i.scan(tx.QueryRowContext(ctx, `INSERT INTO public.league_invites
		(id,league_id,issued_by,issued_at,expires_at,key_version,credential_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING `+inviteFields, id, leagueID, actor, issued, issued.Add(invitePeriod), li.Config.CurrentVersion(), li.Config.IssueHash(leagueID, id)))
}

func revokeInvite(c *gin.Context, ctx context.Context, tx *sql.Tx, i *invite, leagueID string, cmd inviteCommand) bool {
	err := loadInvite(ctx, tx, i, leagueID, cmd.target)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 404, "NOT_FOUND", "招待が見つかりません", nil)
	case err != nil:
		httpx.Unavailable(c)
	case i.Version != cmd.version:
		httpx.Error(c, 409, "VERSION_CONFLICT", "更新された招待の情報を取得し直してください", nil)
	case i.RevokedAt != nil:
		httpx.Error(c, 409, "STATE_CONFLICT", "この招待は失効済みです", nil)
	default:
		err = i.scan(tx.QueryRowContext(ctx, `UPDATE public.league_invites
			SET revoked_at=clock_timestamp(),version=version+1
			WHERE league_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING `+inviteFields, leagueID, cmd.target))
		if err == nil {
			return true
		}
		httpx.Unavailable(c)
	}
	return false
}
