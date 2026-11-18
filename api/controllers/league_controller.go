package controllers

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

type LeagueController struct{ DB *sql.DB }

type league struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	GroupNumber string `json:"group_number"`
	MyRole      string `json:"my_role"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var limitPattern = regexp.MustCompile(`^[0-9]{1,3}$`)

const myLeagues = `
	SELECT l.id, l.name, l.group_number, m.role
	FROM public.leagues l JOIN public.league_members m ON m.league_id=l.id
	WHERE m.user_id=$1 AND m.status='active' AND m.participant_kind='registered'
	  AND l.group_number IS NOT NULL`

func (lc *LeagueController) List(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	rows, err := lc.DB.QueryContext(ctx, myLeagues+` ORDER BY l.name COLLATE "C", l.id`, c.GetString("participant_id"))
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	defer rows.Close()
	leagues := []league{}
	for rows.Next() {
		var l league
		if err := rows.Scan(&l.ID, &l.Name, &l.GroupNumber, &l.MyRole); err != nil {
			httpx.Unavailable(c)
			return
		}
		leagues = append(leagues, l)
	}
	if rows.Err() != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(200, gin.H{"leagues": leagues})
}

type leagueRead func(*gin.Context, context.Context, *sql.Tx, league) gin.H

// Authorization and data reads share one snapshot. A membership committed as
// withdrawn before this snapshot cannot authorize a new request.
func (lc *LeagueController) scoped(id func(*gin.Context) string, read leagueRead) gin.HandlerFunc {
	return func(c *gin.Context) {
		leagueID := strings.ToLower(id(c))
		if !uuidPattern.MatchString(leagueID) {
			invalidQuery(c, "league_id")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		tx, err := lc.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
		if err != nil {
			httpx.Unavailable(c)
			return
		}
		defer tx.Rollback()
		var l league
		err = tx.QueryRowContext(ctx, myLeagues+` AND l.id=$2`, c.GetString("participant_id"), leagueID).
			Scan(&l.ID, &l.Name, &l.GroupNumber, &l.MyRole)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			httpx.Error(c, 403, "LEAGUE_ACCESS_DENIED", "このリーグは閲覧できません", nil)
			return
		case err != nil:
			httpx.Unavailable(c)
			return
		}
		if _, err := tx.ExecContext(ctx, `SELECT set_config('mjstats.league_id',$1,true)`, l.ID); err != nil {
			httpx.Unavailable(c)
			return
		}
		body := read(c, ctx, tx, l)
		if body == nil {
			return
		}
		if err := tx.Commit(); err != nil {
			httpx.Unavailable(c)
			return
		}
		c.JSON(200, body)
	}
}

func pathLeague(c *gin.Context) string { return c.Param("league_id") }

func (lc *LeagueController) Detail() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(_ *gin.Context, _ context.Context, _ *sql.Tx, l league) gin.H {
		return gin.H{"league": l}
	})
}

func invalidQuery(c *gin.Context, field string) {
	httpx.Error(c, 400, "INVALID_INPUT", "入力内容を確認してください", map[string]string{field: "指定を確認してください"})
}

func queryParams(c *gin.Context, allowed ...string) (url.Values, bool) {
	q, err := url.ParseQuery(c.Request.URL.RawQuery)
	if err != nil {
		invalidQuery(c, "query")
		return nil, false
	}
	for name, values := range q {
		valid := false
		for _, field := range allowed {
			valid = valid || name == field
		}
		if !valid || len(values) != 1 || values[0] == "" {
			if !valid {
				name = "query"
			}
			invalidQuery(c, name)
			return nil, false
		}
	}
	return q, true
}

type pageCursor struct {
	Version int    `json:"v"`
	Viewer  string `json:"viewer"`
	League  string `json:"league"`
	List    string `json:"list"`
	Filter  string `json:"filter"`
	Key     string `json:"key"`
	Second  string `json:"second,omitempty"`
	ID      string `json:"id"`
}

func timestampKey(s string, nullKey string) bool {
	if s == nullKey {
		return true
	}
	// Match the UTC format emitted by the SELECT. Reject values such as
	// year 0000 before they reach the PostgreSQL timestamptz cast.
	const format = "2006-01-02T15:04:05.000000Z"
	instant, err := time.Parse(format, s)
	return err == nil && instant.Year() > 0 && instant.Format(format) == s
}

func pageInput(c *gin.Context, q url.Values, l league, list, filter string, keys func(pageCursor) bool) (int, pageCursor, bool) {
	limit := 20
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if !limitPattern.MatchString(raw) || err != nil || n < 1 || n > 100 {
			invalidQuery(c, "limit")
			return 0, pageCursor{}, false
		}
		limit = n
	}
	want := pageCursor{Version: 1, Viewer: c.GetString("participant_id"), League: l.ID, List: list, Filter: filter}
	raw := q.Get("cursor")
	if raw == "" {
		return limit, want, true
	}
	var got pageCursor
	if len(raw) > 4096 {
		invalidQuery(c, "cursor")
		return 0, pageCursor{}, false
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || json.Unmarshal(data, &got) != nil || !uuidPattern.MatchString(got.ID) || !keys(got) {
		invalidQuery(c, "cursor")
		return 0, pageCursor{}, false
	}
	canonical, _ := json.Marshal(got)
	scope := got
	scope.Key, scope.Second, scope.ID = "", "", ""
	if scope != want || base64.RawURLEncoding.EncodeToString(canonical) != raw {
		invalidQuery(c, "cursor")
		return 0, pageCursor{}, false
	}
	return limit, got, true
}

func pageResponse(c *gin.Context, rows *sql.Rows, err error, limit int, cursor pageCursor) gin.H {
	if err != nil {
		httpx.Unavailable(c)
		return nil
	}
	defer rows.Close()
	items := []json.RawMessage{}
	var next *string
	for rows.Next() {
		if len(items) == limit {
			b, _ := json.Marshal(cursor)
			encoded := base64.RawURLEncoding.EncodeToString(b)
			next = &encoded
			break
		}
		var item json.RawMessage
		if err := rows.Scan(&item, &cursor.Key, &cursor.Second, &cursor.ID); err != nil {
			httpx.Unavailable(c)
			return nil
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		httpx.Unavailable(c)
		return nil
	}
	return gin.H{cursor.List: items, "next_cursor": next}
}

type referenceQuery struct {
	// SQL fragments are defined in code. All request values use parameters.
	source, fields, key, keyText, keyParam string
	validKey                               func(pageCursor) bool
}

const memberSource = `FROM public.league_members m JOIN public.users u ON u.id=m.user_id AND u.participant_kind=m.participant_kind
	WHERE m.league_id=$1 AND m.status IN ('active','left','removed') AND m.participant_kind IN ('registered','guest')`

func nameKey(p pageCursor) bool {
	return utf8.ValidString(p.Key) && utf8.RuneCountInString(p.Key) <= 100 && !strings.ContainsRune(p.Key, 0) && p.Second == ""
}

func createdKey(p pageCursor) bool { return timestampKey(p.Key, "infinity") && p.Second == "" }

var references = map[string]referenceQuery{
	"participants": {
		memberSource + ` AND m.status='active'`,
		`'id',u.id,'name',u.name,'kind',u.participant_kind,'version',u.version::text`,
		`u.name COLLATE "C"`, `u.name`, `$4::text COLLATE "C"`, nameKey,
	},
	"members": {
		memberSource,
		`'user_id',u.id,'name',u.name,'kind',u.participant_kind,'role',m.role,'status',m.status,'version',m.version::text`,
		`u.name COLLATE "C"`, `u.name`, `$4::text COLLATE "C"`, nameKey,
	},
	"rules": {
		`FROM public.rules u WHERE u.league_id=$1 AND ($2='all' OR u.available::text=$2)`,
		`'id',u.id,'name',u.name,'default_points',u.default_points,'return_points',u.return_points,
		  'uma',json_build_array(u.uma_1,u.uma_2,u.uma_3,u.uma_4),'calculation_version',u.calculation_version,
		  'available',u.available,'version',u.version::text`,
		`COALESCE(u.created_at,'infinity')`,
		`COALESCE(to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'infinity')`,
		`$4::timestamptz`, createdKey,
	},
	"seasons": {
		`FROM public.seasons u WHERE u.league_id=$1`,
		`'id',u.id,'name',u.name,'start_date',u.start_date,'end_date',u.end_date,'version',u.version::text`,
		`COALESCE(u.created_at,'infinity')`,
		`COALESCE(to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'infinity')`,
		`$4::timestamptz`, createdKey,
	},
}

func (lc *LeagueController) Reference(list string) gin.HandlerFunc {
	spec := references[list]
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		params := []string{"limit", "cursor"}
		if list == "rules" {
			params = append(params, "available")
		}
		q, ok := queryParams(c, params...)
		if !ok {
			return nil
		}
		filter := q.Get("available")
		if list == "rules" && filter == "" {
			filter = "true"
		}
		if list == "rules" && filter != "true" && filter != "false" && filter != "all" {
			invalidQuery(c, "available")
			return nil
		}
		limit, cursor, ok := pageInput(c, q, l, list, filter, spec.validKey)
		if !ok {
			return nil
		}

		// An absent cursor bypasses comparison, but its parameters must still be well-typed.
		key := cursor.Key
		if key == "" && spec.keyParam == `$4::timestamptz` {
			key = "infinity"
		}
		query := `SELECT json_build_object(` + spec.fields + `), ` + spec.keyText + `, '', u.id
			` + spec.source + ` AND $2::text IS NOT NULL
			AND ($3::uuid IS NULL OR (` + spec.key + `,u.id) > (` + spec.keyParam + `,$3::uuid))
			ORDER BY ` + spec.key + `,u.id LIMIT $5`
		var after any
		if cursor.ID != "" {
			after = cursor.ID
		}
		rows, err := tx.QueryContext(ctx, query, l.ID, filter, after, key, limit+1)
		return pageResponse(c, rows, err, limit, cursor)
	})
}
