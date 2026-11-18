package controllers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/invites"
	"github.com/kosuke/mj-stats-api/models"
)

type LeagueParticipation struct {
	Auth    *auth.Guard
	Limiter *AttemptLimiter
}

type discoverableLeague struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	GroupNumber string `json:"group_number"`
}

const searchName = `lower(normalize(name,NFKC) COLLATE pg_catalog."und-x-icu") COLLATE "C"`

func (p *LeagueParticipation) Search(c *gin.Context) {
	q, ok := queryParams(c, "q", "limit", "cursor")
	if !ok {
		return
	}
	term, err := models.NormalizeLeagueName(q.Get("q"))
	if err != nil {
		invalidQuery(c, "q")
		return
	}
	if p.Limiter == nil {
		httpx.Unavailable(c)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	if err := p.Auth.DB.QueryRowContext(ctx, `SELECT lower(normalize($1::text,NFKC) COLLATE pg_catalog."und-x-icu")`, term).Scan(&term); err != nil {
		httpx.Unavailable(c)
		return
	}
	if n := utf8.RuneCountInString(term); n < 2 || n > 100 {
		invalidQuery(c, "q")
		return
	}
	limit, cursor, ok := pageInput(c, q, league{}, "leagues", term, func(cur pageCursor) bool {
		return cur.Key != "" && utf8.ValidString(cur.Key) && !strings.ContainsRune(cur.Key, 0) && cur.Second == ""
	})
	if !ok || !p.Limiter.allow(c, p.Auth.DB, attemptBucket{"search.actor\x00" + c.GetString("participant_id"), p.Limiter.search}) {
		return
	}
	rows, err := p.Auth.DB.QueryContext(ctx, `SELECT jsonb_build_object('id',id,'name',name,'group_number',group_number),
		`+searchName+`,'',id FROM public.leagues
		WHERE search_listed AND group_number IS NOT NULL AND strpos(`+searchName+`,$1)>0
		AND (NULLIF($3,'')::uuid IS NULL OR (`+searchName+`,id)>($2::text COLLATE "C",NULLIF($3,'')::uuid))
		ORDER BY `+searchName+`,id LIMIT $4`, term, cursor.Key, cursor.ID, limit+1)
	if body := pageResponse(c, rows, err, limit, cursor); body != nil {
		c.JSON(200, body)
	}
}

var groupNumberPattern = regexp.MustCompile("^[0-9]{12}$")
var groupSeparators = strings.NewReplacer("-", "", " ", "")

func groupNumber(c *gin.Context, raw string) (string, bool) {
	group := groupSeparators.Replace(strings.TrimSpace(raw))
	if !groupNumberPattern.MatchString(group) {
		invalidQuery(c, "group_number")
		return "", false
	}
	return group, true
}

func (p *LeagueParticipation) byNumber(ctx context.Context, group string) (discoverableLeague, error) {
	var l discoverableLeague
	err := p.Auth.DB.QueryRowContext(ctx, `SELECT id,name,group_number FROM public.leagues WHERE group_number=$1`, group).
		Scan(&l.ID, &l.Name, &l.GroupNumber)
	return l, err
}

func (p *LeagueParticipation) Resolve(c *gin.Context) {
	var input struct {
		GroupNumber string `json:"group_number"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	if _, ok := queryParams(c); !ok {
		return
	}
	group, ok := groupNumber(c, input.GroupNumber)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	l, err := p.byNumber(ctx, group)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 404, "NOT_FOUND", "リーグが見つかりません", nil)
	case err != nil:
		httpx.Unavailable(c)
	default:
		c.JSON(200, gin.H{"league": l})
	}
}

func rejectInvalidInvite(c *gin.Context) {
	httpx.Error(c, 404, "INVALID_INVITE", "有効な招待がありません。新しい招待を確認してください", nil)
}

type inviteQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func compareJoinInvite(ctx context.Context, db inviteQuerier, leagueID, actor string, replay any, code string) (string, time.Time, error) {
	var id, hash string
	var expires time.Time
	err := db.QueryRowContext(ctx, `SELECT id,credential_hash,expires_at FROM mjstats_private.join_invite($1,$2,$3)`,
		leagueID, actor, replay).Scan(&id, &hash, &expires)
	if err == nil && !hmac.Equal([]byte(hash), []byte(invites.Hash(code))) {
		err = sql.ErrNoRows
	}
	return id, expires.UTC(), err
}

func (p *LeagueParticipation) Preview(c *gin.Context) {
	var input struct {
		GroupNumber string `json:"group_number"`
		Code        string `json:"code"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	if _, ok := queryParams(c); !ok {
		return
	}
	group, ok := groupNumber(c, input.GroupNumber)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	l, err := p.byNumber(ctx, group)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		httpx.Unavailable(c)
		return
	}
	if !p.allowInviteAttempt(c, l.ID) {
		return
	}
	code := invites.NormalizeCode(input.Code)
	if code == "" {
		invalidQuery(c, "code")
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		rejectInvalidInvite(c)
		return
	}
	_, expires, err := compareJoinInvite(ctx, p.Auth.DB, l.ID, c.GetString("participant_id"), nil, code)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		rejectInvalidInvite(c)
	case err != nil:
		httpx.Unavailable(c)
	default:
		c.JSON(200, gin.H{"league": l, "expires_at": expires})
	}
}

type joinMembership struct {
	LeagueID string `json:"league_id"`
	UserID   string `json:"user_id"`
	Kind     string `json:"kind"`
	Role     string `json:"role"`
	Status   string `json:"status"`
	Version  string `json:"version"`
}

func (m *joinMembership) scan(row *sql.Row) error {
	return row.Scan(&m.Kind, &m.Role, &m.Status, &m.Version)
}

func (p *LeagueParticipation) Join(c *gin.Context) {
	var input struct {
		Code            string `json:"code"`
		ClientRequestID string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	leagueID := strings.ToLower(pathLeague(c))
	if !uuidPattern.MatchString(leagueID) {
		invalidQuery(c, "league_id")
		return
	}
	if !uuidPattern.MatchString(input.ClientRequestID) {
		invalidQuery(c, "client_request_id")
		return
	}
	if _, ok := queryParams(c); !ok {
		return
	}
	if !p.allowInviteAttempt(c, leagueID) {
		return
	}
	code := invites.NormalizeCode(input.Code)
	if code == "" {
		invalidQuery(c, "code")
		return
	}

	tx, ctx, cancel, err := p.Auth.BeginWrite(c)
	if err != nil {
		auth.Reject(c, err)
		return
	}
	defer cancel()
	defer tx.Rollback()
	var target string
	err = tx.QueryRowContext(ctx, `SELECT id FROM public.leagues WHERE id=$1 AND group_number IS NOT NULL FOR UPDATE`, leagueID).
		Scan(&target)
	if errors.Is(err, sql.ErrNoRows) {
		rejectInvalidInvite(c)
		return
	}
	if err != nil {
		httpx.Unavailable(c)
		return
	}

	actor := c.GetString("participant_id")
	if !lockRegisteredActor(c, ctx, tx, actor) {
		return
	}
	membership := joinMembership{LeagueID: leagueID, UserID: actor}
	err = membership.scan(tx.QueryRowContext(ctx, `SELECT participant_kind,role,status,version::text FROM public.league_members
		WHERE league_id=$1 AND user_id=$2 FOR UPDATE`, leagueID, actor))
	existing := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		httpx.Unavailable(c)
		return
	}

	requestID := strings.ToLower(input.ClientRequestID)
	_, err = tx.ExecContext(ctx, `SELECT set_config('mjstats.league_actor_id',$1,true),
		set_config('mjstats.join_league_id',$2,true),
		pg_advisory_xact_lock(hashtextextended('league.join:' || $1 || ':' || $3,0))`, actor, leagueID, requestID)
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	var previousLeague string
	err = tx.QueryRowContext(ctx, `SELECT league_id FROM public.league_events
		WHERE actor_id=$1 AND operation='league.join' AND client_request_id=$2`, actor, requestID).
		Scan(&previousLeague)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		httpx.Unavailable(c)
		return
	}
	if previousLeague != "" {
		if previousLeague != leagueID {
			rejectJoinConflict(c)
			return
		}
		_, _, err = compareJoinInvite(ctx, tx, leagueID, actor, requestID, code)
		if errors.Is(err, sql.ErrNoRows) {
			rejectJoinConflict(c)
			return
		}
		// A replay reports the current membership and cannot restore a later exit.
		if err != nil || !existing {
			httpx.Unavailable(c)
			return
		}
	} else {
		inviteID, _, err := compareJoinInvite(ctx, tx, leagueID, actor, nil, code)
		if errors.Is(err, sql.ErrNoRows) {
			rejectInvalidInvite(c)
			return
		}
		if err != nil {
			httpx.Unavailable(c)
			return
		}
		if !applyJoin(c, ctx, tx, &membership, existing, inviteID, requestID) {
			return
		}
	}
	if !p.Auth.BeforeCommit(c) {
		httpx.Unauthenticated(c)
		return
	}
	if tx.Commit() != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(200, gin.H{"membership": membership})
}

func rejectJoinConflict(c *gin.Context) {
	httpx.Error(c, 409, "IDEMPOTENCY_CONFLICT", "同じ操作IDが別の内容で使われています", nil)
}

func applyJoin(c *gin.Context, ctx context.Context, tx *sql.Tx, m *joinMembership, existing bool, inviteID, requestID string) bool {
	const returning = ` RETURNING participant_kind,role,status,version::text`
	var err error
	switch {
	case !existing:
		err = m.scan(tx.QueryRowContext(ctx, `INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
			VALUES ($1,$2,'registered','member','active') ON CONFLICT (league_id,user_id) DO NOTHING`+returning, m.LeagueID, m.UserID))
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(c, 409, "STATE_CONFLICT", "この所属は変更できません", nil)
			return false
		}
	case m.Status == "left" || m.Status == "removed":
		err = m.scan(tx.QueryRowContext(ctx, `UPDATE public.league_members SET role='member',status='active',ended_at=NULL,version=version+1
			WHERE league_id=$1 AND user_id=$2 AND participant_kind='registered' AND status IN ('left','removed')`+returning, m.LeagueID, m.UserID))
	case m.Status != "active" || m.Kind != "registered":
		httpx.Error(c, 409, "STATE_CONFLICT", "この所属は変更できません", nil)
		return false
	}
	if err == nil {
		// The linked invitation, rather than any credential in the event,
		// records which code was accepted for subsequent replay checks.
		digest := sha256.Sum256([]byte("league.join:v1\x00" + m.LeagueID + "\x00" + inviteID))
		_, err = tx.ExecContext(ctx, `INSERT INTO public.league_events
			(league_id,actor_id,operation,client_request_id,target,version,request_hash,after,join_invite_id)
			VALUES ($1,$2,'league.join',$3,$2,$4,$5,'{}'::jsonb,$6)`,
			m.LeagueID, m.UserID, requestID, m.Version, hex.EncodeToString(digest[:]), inviteID)
	}
	if err != nil {
		httpx.Unavailable(c)
		return false
	}
	return true
}
