package controllers

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/models"
)

const leagueSettingsJSON = `json_build_object('id',id,'name',name,'search_listed',search_listed,'version',version::text)`

func (lc *LeagueController) Settings() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		if !requireManager(c, l) {
			return nil
		}
		if _, ok := queryParams(c); !ok {
			return nil
		}
		var data json.RawMessage
		if err := tx.QueryRowContext(ctx, `SELECT `+leagueSettingsJSON+` FROM public.leagues WHERE id=$1`, l.ID).Scan(&data); err != nil {
			httpx.Unavailable(c)
			return nil
		}
		return gin.H{"settings": data}
	})
}

func (w *LeagueWrite) UpdateSettings(c *gin.Context) {
	var input struct {
		Name    string `json:"name"`
		Listed  *bool  `json:"search_listed"`
		Version string `json:"version"`
		ID      string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) || !normalizeVersion(c, input.Version) {
		return
	}
	name, err := models.NormalizeLeagueName(input.Name)
	if err != nil || input.Listed == nil {
		httpx.Invalid(c)
		return
	}
	w.manage(c, managementCommand{operation: "league.settings", requestID: input.ID, version: input.Version,
		managerOnly: true, payload: []any{name, *input.Listed}}, func(ctx context.Context, tx *sql.Tx, l league, _ string) *managementChange {
		return updateSetting(c, input.Version, l.ID,
			tx.QueryRowContext(ctx, `SELECT version::text,`+leagueSettingsJSON+` FROM public.leagues WHERE id=$1`, l.ID),
			func() *sql.Row {
				return tx.QueryRowContext(ctx, `UPDATE public.leagues SET name=$2,search_listed=$3,version=version+1
					WHERE id=$1 RETURNING version::text,`+leagueSettingsJSON, l.ID, name, *input.Listed)
			})
	})
}

func updateSetting(c *gin.Context, version, target string, row *sql.Row, update func() *sql.Row) *managementChange {
	result := &managementChange{id: target}
	var before, after json.RawMessage
	if !managementFound(c, row.Scan(&result.version, &before)) || !checkVersion(c, result.version, version) {
		return nil
	}
	if err := update().Scan(&result.version, &after); err != nil {
		httpx.Unavailable(c)
		return nil
	}
	result.before, result.after = before, after
	return result
}

func (w *LeagueWrite) CreateRule(c *gin.Context) {
	var input struct {
		Name   string   `json:"name"`
		Start  int32    `json:"default_points"`
		Return int32    `json:"return_points"`
		Uma    []*int32 `json:"uma"`
		ID     string   `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	name, err := models.NormalizeLeagueName(input.Name)
	if err != nil || input.Start <= 0 || input.Return < input.Start || input.Start%100 != 0 || input.Return%100 != 0 || len(input.Uma) != 4 {
		httpx.Invalid(c)
		return
	}
	var total int64
	for i, uma := range input.Uma {
		if uma == nil || (i > 0 && *input.Uma[i-1] < *uma) {
			invalidQuery(c, "uma")
			return
		}
		total += int64(*uma)
	}
	if total != 0 {
		invalidQuery(c, "uma")
		return
	}
	w.manage(c, managementCommand{operation: "rule.create", requestID: input.ID, managerOnly: true,
		payload: []any{name, input.Start, input.Return, input.Uma}}, func(ctx context.Context, tx *sql.Tx, l league, _ string) *managementChange {
		var rule creationRule
		err := rule.scan(tx.QueryRowContext(ctx, `INSERT INTO public.rules
			(league_id,name,default_points,return_points,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'exact_v1',true) RETURNING `+creationRuleFields,
			l.ID, name, input.Start, input.Return, input.Uma[0], input.Uma[1], input.Uma[2], input.Uma[3]))
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		return &managementChange{id: rule.ID, version: rule.Version, after: rule, created: true}
	})
}

func (w *LeagueWrite) SetRuleAvailability(c *gin.Context) {
	var input struct {
		Available *bool  `json:"available"`
		Version   string `json:"version"`
		ID        string `json:"client_request_id"`
	}
	id := c.Param("id")
	if !httpx.Decode(c, &input) || !normalizeUUID(c, &id, "id") || !normalizeVersion(c, input.Version) {
		return
	}
	if input.Available == nil {
		invalidQuery(c, "available")
		return
	}
	w.manage(c, managementCommand{operation: "rule.available", requestID: input.ID, target: id,
		version: input.Version, managerOnly: true, payload: *input.Available}, func(ctx context.Context, tx *sql.Tx, l league, _ string) *managementChange {
		const record = `json_build_object('id',id,'name',name,'available',available,'version',version::text)`
		return updateSetting(c, input.Version, id,
			tx.QueryRowContext(ctx, `SELECT version::text,`+record+` FROM public.rules WHERE league_id=$1 AND id=$2`, l.ID, id),
			func() *sql.Row {
				return tx.QueryRowContext(ctx, `UPDATE public.rules SET available=$3,version=version+1
					WHERE league_id=$1 AND id=$2 RETURNING version::text,`+record, l.ID, id, *input.Available)
			})
	})
}

type seasonSettings struct {
	Name    string  `json:"name"`
	Start   *string `json:"start_date"`
	End     *string `json:"end_date"`
	Version string  `json:"version,omitempty"`
	ID      string  `json:"client_request_id"`
}

func validSeasonDate(date *string) bool {
	if date == nil {
		return true
	}
	t, err := time.Parse(time.DateOnly, *date)
	return err == nil && t.Year() > 0
}

func (w *LeagueWrite) SaveSeason(edit bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var input seasonSettings
		if !httpx.Decode(c, &input) {
			return
		}
		name, err := models.NormalizeLeagueName(input.Name)
		if err != nil || !validSeasonDate(input.Start) || !validSeasonDate(input.End) ||
			(input.Start != nil && input.End != nil && *input.Start > *input.End) {
			httpx.Invalid(c)
			return
		}
		id, operation := c.Param("id"), "season.create"
		if edit {
			operation = "season.update"
			if !normalizeUUID(c, &id, "id") || !normalizeVersion(c, input.Version) {
				return
			}
		} else if input.Version != "" {
			invalidQuery(c, "version")
			return
		}
		w.manage(c, managementCommand{operation: operation, requestID: input.ID, target: id, version: input.Version,
			managerOnly: true, payload: []any{name, input.Start, input.End}}, func(ctx context.Context, tx *sql.Tx, l league, _ string) *managementChange {
			const record = `json_build_object('id',id,'name',name,'start_date',start_date,'end_date',end_date,'version',version::text)`
			if !edit {
				var result managementChange
				var data json.RawMessage
				err := tx.QueryRowContext(ctx, `INSERT INTO public.seasons(league_id,name,start_date,end_date)
					VALUES ($1,$2,$3,$4) RETURNING id,version::text,`+record, l.ID, name, input.Start, input.End).
					Scan(&result.id, &result.version, &data)
				if err != nil {
					httpx.Unavailable(c)
					return nil
				}
				result.after, result.created = data, true
				return &result
			}
			var version string
			var before, after json.RawMessage
			var referencedPeriodChange bool
			err := tx.QueryRowContext(ctx, `SELECT version::text,`+record+`,
				(start_date IS DISTINCT FROM $3::date OR end_date IS DISTINCT FROM $4::date) AND (
					EXISTS(SELECT 1 FROM public.matches m WHERE m.league_id=$1 AND m.season_id=$2)
					OR EXISTS(SELECT 1 FROM public.match_revisions r WHERE r.league_id=$1
						AND (r.before->>'season_id'=$2::text OR r.after->>'season_id'=$2::text)))
				FROM public.seasons WHERE league_id=$1 AND id=$2::uuid`, l.ID, id, input.Start, input.End).Scan(&version, &before, &referencedPeriodChange)
			if !managementFound(c, err) || !checkVersion(c, version, input.Version) {
				return nil
			}
			if referencedPeriodChange {
				stateConflict(c, "対局に使用したシーズンの期間は変更できません")
				return nil
			}
			err = tx.QueryRowContext(ctx, `UPDATE public.seasons SET name=$3,start_date=$4,end_date=$5,version=version+1
				WHERE league_id=$1 AND id=$2 RETURNING version::text,`+record, l.ID, id, name, input.Start, input.End).Scan(&version, &after)
			if err != nil {
				httpx.Unavailable(c)
				return nil
			}
			return &managementChange{id: id, version: version, before: before, after: after}
		})
	}
}

func (w *LeagueWrite) RenameGuest(c *gin.Context) {
	var input struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		ID      string `json:"client_request_id"`
	}
	id := c.Param("user_id")
	if !httpx.Decode(c, &input) || !normalizeUUID(c, &id, "user_id") || !normalizeVersion(c, input.Version) {
		return
	}
	name, err := models.NormalizeName(input.Name)
	if err != nil {
		invalidQuery(c, "name")
		return
	}
	w.manage(c, managementCommand{operation: "guest.rename", requestID: input.ID, target: id, version: input.Version,
		managerOnly: true, payload: name}, func(ctx context.Context, tx *sql.Tx, l league, _ string) *managementChange {
		if !lockMember(c, ctx, tx, l.ID, id, "guest") {
			return nil
		}
		var active bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM public.participant_links WHERE league_id=$1 AND guest_user_id=$2 AND status='active')`,
			l.ID, id).Scan(&active)
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		if active {
			stateConflict(c, "本人に紐付いているゲスト名は変更できません")
			return nil
		}
		const record = `json_build_object('id',id,'name',name,'version',version::text)`
		return updateSetting(c, input.Version, id,
			tx.QueryRowContext(ctx, `SELECT version::text,`+record+` FROM public.users WHERE id=$1 AND participant_kind='guest'`, id),
			func() *sql.Row {
				return tx.QueryRowContext(ctx, `UPDATE public.users SET name=$2,version=version+1
					WHERE id=$1 AND participant_kind='guest' RETURNING version::text,`+record, id, name)
			})
	})
}

func (w *LeagueWrite) RevokeLink(c *gin.Context) {
	var input versionedReason
	id := c.Param("id")
	if !httpx.Decode(c, &input) || !normalizeUUID(c, &id, "id") || !normalizeVersion(c, input.Version) || !normalizeReason(c, &input.Reason) {
		return
	}
	w.manage(c, managementCommand{operation: "participant-link.revoke", requestID: input.ClientRequestID, target: id,
		version: input.Version, reason: input.Reason, managerOnly: true, ownerOnly: true}, func(ctx context.Context, tx *sql.Tx, l league, actor string) *managementChange {
		var before, after json.RawMessage
		var status, version string
		const fields = `json_build_object(` + linkFields + `)`
		const source = linkSource + ` WHERE p.league_id=$1 AND p.id=$2`
		err := tx.QueryRowContext(ctx, `SELECT p.status,p.version::text,`+fields+" "+source, l.ID, id).Scan(&status, &version, &before)
		if !managementFound(c, err) || !checkVersion(c, version, input.Version) {
			return nil
		}
		if status != "active" {
			stateConflict(c, "解除できるのは有効な本人紐付けだけです")
			return nil
		}
		err = tx.QueryRowContext(ctx, `UPDATE public.participant_links
			SET status='revoked',revoked_by=$3,revoked_at=statement_timestamp(),revoke_reason=$4,version=version+1
			WHERE league_id=$1 AND id=$2 RETURNING version::text`, l.ID, id, actor, input.Reason).Scan(&version)
		if err == nil {
			err = tx.QueryRowContext(ctx, `SELECT `+fields+" "+source, l.ID, id).Scan(&after)
		}
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		return &managementChange{id: id, version: version, before: before, after: after}
	})
}
