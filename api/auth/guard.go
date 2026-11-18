package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

type Guard struct {
	DB       *sql.DB
	Verifier *Verifier
}
type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (g *Guard) check(ctx context.Context, q queryer, claims *Claims) error {
	if !g.Verifier.Current(claims) {
		return ErrInvalid
	}
	var valid bool
	if err := q.QueryRowContext(ctx, `SELECT mjstats_private.valid_session($1::uuid, $2::uuid)`, claims.Subject, claims.SessionID).Scan(&valid); err != nil {
		return ErrUnavailable
	}
	if !valid || !g.Verifier.Current(claims) {
		return ErrInvalid
	}
	return nil
}

func (g *Guard) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		parts := strings.Fields(c.GetHeader("Authorization"))
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			httpx.Unauthenticated(c)
			return
		}
		claims, err := g.Verifier.Verify(c.Request.Context(), parts[1])
		if err != nil {
			Reject(c, err)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		if err := g.check(ctx, g.DB, claims); err != nil {
			Reject(c, err)
			return
		}
		c.Set("auth_claims", claims)
		c.Next()
	}
}

func (g *Guard) RequireProfile() gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := From(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		var complete sql.NullTime
		var id string
		err := g.DB.QueryRowContext(ctx, `SELECT id, profile_completed_at FROM public.users WHERE auth_id=$1 AND participant_kind='registered'`, claims.Subject).Scan(&id, &complete)
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(c, 403, "PROFILE_REQUIRED", "本人情報を取得してください", nil)
			return
		}
		if err != nil {
			httpx.Unavailable(c)
			return
		}
		if !complete.Valid {
			httpx.Error(c, 403, "PROFILE_INCOMPLETE", "表示名を設定してください", nil)
			return
		}
		c.Set("participant_id", id)
		c.Next()
	}
}

func From(c *gin.Context) *Claims { return c.MustGet("auth_claims").(*Claims) }

func Reject(c *gin.Context, err error) {
	if errors.Is(err, ErrInvalid) {
		httpx.Unauthenticated(c)
	} else {
		httpx.Unavailable(c)
	}
}

// Every write transaction must take Auth locks before app row locks/changes.
func (g *Guard) BeginWrite(c *gin.Context) (*sql.Tx, context.Context, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	tx, err := g.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err == nil {
		_, err = tx.ExecContext(ctx, `SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'`)
	}
	if err == nil {
		err = g.check(ctx, tx, From(c))
	}
	if err != nil {
		if tx != nil {
			_ = tx.Rollback()
		}
		cancel()
		if !errors.Is(err, ErrInvalid) {
			err = ErrUnavailable
		}
		return nil, nil, func() {}, err
	}
	return tx, ctx, cancel, nil
}

func (g *Guard) BeforeCommit(c *gin.Context) bool { return g.Verifier.Current(From(c)) }
