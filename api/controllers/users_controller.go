package controllers

import (
	"database/sql"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/models"
)

type UserController struct{ Auth *auth.Guard }

func (uc *UserController) GetMe(c *gin.Context) {
	tx, ctx, cancel, err := uc.Auth.BeginWrite(c)
	if err != nil {
		auth.Reject(c, err)
		return
	}
	defer cancel()
	defer tx.Rollback()
	// A fresh READ COMMITTED statement sees the winning concurrent insert.
	_, err = tx.ExecContext(ctx, `INSERT INTO public.users (auth_id, name, participant_kind)
   VALUES ($1, 'Player', 'registered') ON CONFLICT (auth_id) DO NOTHING`, auth.From(c).Subject)
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	var user models.User
	err = tx.QueryRowContext(ctx, `SELECT id, name, profile_completed_at FROM public.users WHERE auth_id=$1`, auth.From(c).Subject).Scan(&user.ID, &user.Name, &user.ProfileCompletedAt)
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	if !uc.Auth.BeforeCommit(c) {
		httpx.Unauthenticated(c)
		return
	}
	if tx.Commit() != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(200, user)
}

func (uc *UserController) UpdateMe(c *gin.Context) {
	var input struct {
		Name *string `json:"name"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	if input.Name == nil {
		httpx.Invalid(c)
		return
	}
	name, err := models.NormalizeName(*input.Name)
	if err != nil {
		httpx.Error(c, 400, "INVALID_INPUT", "表示名を確認してください", map[string]string{"name": "前後の空白を除き1〜30文字。改行・制御文字は使えません"})
		return
	}
	tx, ctx, cancel, err := uc.Auth.BeginWrite(c)
	if err != nil {
		auth.Reject(c, err)
		return
	}
	defer cancel()
	defer tx.Rollback()
	var user models.User
	err = tx.QueryRowContext(ctx, `UPDATE public.users
   SET name=$2, profile_completed_at=COALESCE(profile_completed_at, clock_timestamp()), version=version+1
   WHERE auth_id=$1 AND participant_kind='registered'
   RETURNING id, name, profile_completed_at`, auth.From(c).Subject, name).Scan(&user.ID, &user.Name, &user.ProfileCompletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, 403, "PROFILE_REQUIRED", "本人情報を取得してください", nil)
		return
	}
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	if !uc.Auth.BeforeCommit(c) {
		httpx.Unauthenticated(c)
		return
	}
	if tx.Commit() != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(200, user)
}
