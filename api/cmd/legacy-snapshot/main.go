// Read-only snapshot of the seven legacy application tables. Never dumps Auth.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/joho/godotenv"
	"github.com/lib/pq"
	"net/url"
	"os"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		var pg *pq.Error
		code := ""
		if errors.As(err, &pg) {
			code = string(pg.Code)
 if strings.Contains(pg.Message,"Tenant or user not found") { code += " (pooler tenant/user lookup failed)" }
		}
		fmt.Fprintf(os.Stderr, "Read-only legacy snapshot failed: type=%T sqlstate=%s (details withheld)\n", err, code)
		os.Exit(1)
	}
}
func run() error {
	env, err := godotenv.Read(".env")
	if err != nil {
		return err
	}
	u, err := url.Parse(env["DATABASE_URL"])
	if err != nil {
		return err
	}
	q := u.Query()
	q.Del("pgbouncer")
	q.Set("connect_timeout", "5")
	u.RawQuery = q.Encode()
	db, err := sql.Open("postgres", u.String())
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mode string
	if err = tx.QueryRowContext(ctx, `SHOW transaction_read_only`).Scan(&mode); err != nil || mode != "on" {
		return fmt.Errorf("read-only required")
	}
	data := map[string]json.RawMessage{}
	queries := map[string]string{
		"columns":     `SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position),'[]') FROM (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','leagues','league_members','seasons','rules','matches','match_results')) c`,
		"constraints": `SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,conname) FROM (SELECT t.relname table_name,c.conname,c.contype,pg_get_constraintdef(c.oid) definition,c.convalidated FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname IN ('users','leagues','league_members','seasons','rules','matches','match_results')) c`,
		"rls":         `SELECT jsonb_agg(to_jsonb(c) ORDER BY relname) FROM (SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('users','leagues','league_members','seasons','rules','matches','match_results')) c`,
	}
	for name, query := range queries {
		var raw []byte
		if err = tx.QueryRowContext(ctx, query).Scan(&raw); err != nil {
			return err
		}
		data[name] = raw
	}
	counts := map[string]int{}
	for _, table := range []string{"users", "leagues", "league_members", "seasons", "rules", "matches", "match_results"} {
		var raw []byte
		// Identifiers come only from the fixed list above.
		query := `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public.` + table + ` t`
		if err = tx.QueryRowContext(ctx, query).Scan(&raw); err != nil {
			return err
		}
		data[table] = raw
		var rows []json.RawMessage
		if err = json.Unmarshal(raw, &rows); err != nil {
			return err
		}
		counts[table] = len(rows)
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	if len(os.Args) != 2 || !strings.HasSuffix(os.Args[1], ".json") {
		return fmt.Errorf("output required")
	}
	if err = os.WriteFile(os.Args[1], raw, 0600); err != nil {
		return err
	}
	summary, _ := json.Marshal(counts)
	fmt.Printf("Read-only snapshot saved; counts=%s\n", summary)
	return nil
}
