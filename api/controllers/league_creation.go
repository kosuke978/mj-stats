package controllers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/models"
)

type LeagueCreator struct {
	Auth *auth.Guard
	// NextGroupNumber is optional. Production uses a uniform cryptographic draw.
	NextGroupNumber func() (string, error)
}

const maxGroupNumberRegenerations = 5

type leagueCreation struct {
	League league       `json:"league"`
	Rule   creationRule `json:"rule"`
}

type creationRule struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	DefaultPoints      int    `json:"default_points"`
	ReturnPoints       int    `json:"return_points"`
	Uma                [4]int `json:"uma"`
	CalculationVersion string `json:"calculation_version"`
	Available          bool   `json:"available"`
	Version            string `json:"version"`
}

const creationRuleFields = `id, name, default_points, return_points, uma_1, uma_2, uma_3, uma_4,
	calculation_version, available, version::text`

func (r *creationRule) scan(row *sql.Row) error {
	return row.Scan(&r.ID, &r.Name, &r.DefaultPoints, &r.ReturnPoints,
		&r.Uma[0], &r.Uma[1], &r.Uma[2], &r.Uma[3], &r.CalculationVersion, &r.Available, &r.Version)
}

func (lc *LeagueCreator) Create(c *gin.Context) {
	var input struct {
		Name            string `json:"name"`
		ClientRequestID string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	name, err := models.NormalizeLeagueName(input.Name)
	if err != nil {
		httpx.Error(c, 400, "INVALID_INPUT", "リーグ名を確認してください",
			map[string]string{"name": "前後の空白を除き1〜100文字。改行・制御文字は使えません"})
		return
	}
	if !uuidPattern.MatchString(input.ClientRequestID) {
		httpx.Error(c, 400, "INVALID_INPUT", "操作IDを確認してください",
			map[string]string{"client_request_id": "UUIDを指定してください"})
		return
	}
	requestID := strings.ToLower(input.ClientRequestID)
	digest := sha256.Sum256([]byte("league.create:v1\x00" + name))
	hash := hex.EncodeToString(digest[:])

	tx, ctx, cancel, err := lc.Auth.BeginWrite(c)
	if err != nil {
		auth.Reject(c, err)
		return
	}
	defer cancel()
	defer tx.Rollback()

	// Re-read and hold the identity mapping after the existing Auth locks.
	var actor string
	var completed bool
	err = tx.QueryRowContext(ctx, `SELECT id, profile_completed_at IS NOT NULL
		FROM public.users WHERE auth_id=$1 AND participant_kind='registered' FOR SHARE`, auth.From(c).Subject).
		Scan(&actor, &completed)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 403, "PROFILE_REQUIRED", "本人情報を取得してください", nil)
		return
	case err != nil:
		httpx.Unavailable(c)
		return
	case !completed:
		httpx.Error(c, 403, "PROFILE_INCOMPLETE", "表示名を設定してください", nil)
		return
	}

	// A waiter reads the committed event in the next READ COMMITTED statement.
	// The table uniqueness constraint independently prevents two results.
	_, err = tx.ExecContext(ctx, `SELECT set_config('mjstats.league_actor_id',$1,true),
		pg_advisory_xact_lock(hashtextextended('league.create:' || $1 || ':' || $2,0))`, actor, requestID)
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	var result leagueCreation
	var existingLeague, existingRule, existingHash string
	err = tx.QueryRowContext(ctx, `SELECT league_id, initial_rule_id, request_hash
		FROM public.league_events WHERE actor_id=$1 AND operation='league.create' AND client_request_id=$2`,
		actor, requestID).Scan(&existingLeague, &existingRule, &existingHash)
	status := http.StatusCreated
	switch {
	case errors.Is(err, sql.ErrNoRows):
		err = lc.create(ctx, tx, &result, actor, requestID, name, hash)
	case err == nil && existingHash != hash:
		httpx.Error(c, 409, "IDEMPOTENCY_CONFLICT", "同じ操作IDが別の内容で使われています", nil)
		return
	case err == nil:
		status = http.StatusOK
		// Replay resolves the original IDs and applies current read authorization.
		err = tx.QueryRowContext(ctx, myLeagues+` AND l.id=$2`, actor, existingLeague).
			Scan(&result.League.ID, &result.League.Name, &result.League.GroupNumber, &result.League.MyRole)
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(c, 403, "LEAGUE_ACCESS_DENIED", "このリーグは閲覧できません", nil)
			return
		}
		if err == nil {
			err = result.Rule.scan(tx.QueryRowContext(ctx, `SELECT `+creationRuleFields+
				` FROM public.rules WHERE league_id=$1 AND id=$2`, existingLeague, existingRule))
		}
	}
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	if !lc.Auth.BeforeCommit(c) {
		httpx.Unauthenticated(c)
		return
	}
	if tx.Commit() != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(status, result)
}

func randomGroupNumber() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%012d", n.Int64()), nil
}

func (lc *LeagueCreator) create(ctx context.Context, tx *sql.Tx, result *leagueCreation, actor, requestID, name, hash string) error {
	nextNumber := lc.NextGroupNumber
	if nextNumber == nil {
		nextNumber = randomGroupNumber
	}
	var err error
	for attempt := 0; attempt <= maxGroupNumberRegenerations; attempt++ {
		number, drawErr := nextNumber()
		if drawErr != nil {
			return drawErr
		}
		// Only the number's UNIQUE conflict is retryable. Other failures
		// abort the write and the whole transaction rolls back.
		err = tx.QueryRowContext(ctx, `INSERT INTO public.leagues(name, owner_id, group_number, search_listed)
			VALUES ($1,$2,$3,false) ON CONFLICT (group_number) DO NOTHING
			RETURNING id, name, group_number`, name, actor, number).
			Scan(&result.League.ID, &result.League.Name, &result.League.GroupNumber)
		if !errors.Is(err, sql.ErrNoRows) {
			break
		}
	}
	if err != nil {
		return err
	}
	result.League.MyRole = "owner"
	if _, err = tx.ExecContext(ctx, `INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
		VALUES ($1,$2,'registered','owner','active')`, result.League.ID, actor); err != nil {
		return err
	}
	if err = result.Rule.scan(tx.QueryRowContext(ctx, `INSERT INTO public.rules
		(league_id,name,default_points,return_points,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
		VALUES ($1,'標準ルール',25000,30000,20,10,-10,-20,'exact_v1',true)
		RETURNING `+creationRuleFields, result.League.ID)); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO public.league_events
		(league_id,actor_id,operation,client_request_id,target,version,request_hash,after)
		VALUES ($1,$2,'league.create',$3,$1,1,$4,jsonb_build_object(
			'name',$5::text,'group_number',$6::text,'owner_id',$2::uuid,
			'search_listed',false,'initial_rule_id',$7::uuid))`,
		result.League.ID, actor, requestID, hash, name, result.League.GroupNumber, result.Rule.ID)
	return err
}
