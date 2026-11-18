package controllers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/netip"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/lib/pq"
)

type AttemptLimiter struct {
	key                []byte
	search, league, ip int
}

func NewAttemptLimiter(encodedKey, search, league, ip string) (*AttemptLimiter, error) {
	if encodedKey == "" && search == "" && league == "" && ip == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.Strict().DecodeString(encodedKey)
	if err != nil || len(key) < 32 || base64.StdEncoding.EncodeToString(key) != encodedKey {
		return nil, errors.New("invalid attempt limiter configuration")
	}
	config := &AttemptLimiter{key: key, search: 30, league: 10, ip: 60}
	for _, setting := range []struct {
		input string
		limit *int
	}{{search, &config.search}, {league, &config.league}, {ip, &config.ip}} {
		if setting.input == "" {
			continue
		}
		n, err := strconv.ParseInt(setting.input, 10, 32)
		if err != nil || n < 1 || n > 2147483646 {
			return nil, errors.New("invalid attempt limit")
		}
		*setting.limit = int(n)
	}
	return config, nil
}

// Counters expire even when there is no new traffic.
func PruneAttempts(ctx context.Context, db *sql.DB) {
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, _ = db.ExecContext(queryCtx, `SELECT mjstats_private.prune_attempts()`)
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

type attemptBucket struct {
	value string
	limit int
}

func (l *AttemptLimiter) allow(c *gin.Context, db *sql.DB, buckets ...attemptBucket) bool {
	limits := make(map[string]int, len(buckets))
	keys := make([]string, 0, len(buckets))
	for _, b := range buckets {
		mac := hmac.New(sha256.New, l.key)
		mac.Write([]byte("mjstats.rate.v1\x00" + b.value))
		key := hex.EncodeToString(mac.Sum(nil))
		keys = append(keys, key)
		limits[key] = b.limit
	}
	// This statement commits independently of the participation transaction.
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT bucket_key,attempts,retry_after FROM mjstats_private.count_attempt($1)`, pq.Array(keys))
	if err != nil {
		httpx.Unavailable(c)
		return false
	}
	defer rows.Close()
	seen, retry := 0, 0
	for rows.Next() {
		var key string
		var count, seconds int
		if err := rows.Scan(&key, &count, &seconds); err != nil || limits[key] == 0 {
			httpx.Unavailable(c)
			return false
		}
		seen++
		if count > limits[key] {
			retry = max(retry, seconds)
		}
	}
	if rows.Err() != nil || seen != len(limits) {
		httpx.Unavailable(c)
		return false
	}
	if retry > 0 {
		c.Header("Retry-After", strconv.Itoa(retry))
		httpx.Error(c, 429, "RATE_LIMITED", "試行が多すぎます。少し待ってから再試行してください", nil)
		return false
	}
	return true
}

func (p *LeagueParticipation) allowInviteAttempt(c *gin.Context, leagueID string) bool {
	if p.Limiter == nil {
		httpx.Unavailable(c)
		return false
	}
	ip, err := netip.ParseAddr(c.ClientIP())
	if err != nil {
		httpx.Unavailable(c)
		return false
	}
	buckets := []attemptBucket{{"invite.ip\x00" + ip.WithZone("").Unmap().String(), p.Limiter.ip}}
	if leagueID != "" {
		buckets = append(buckets, attemptBucket{
			"invite.actor.league\x00" + c.GetString("participant_id") + "\x00" + leagueID, p.Limiter.league,
		})
	}
	return p.Limiter.allow(c, p.Auth.DB, buckets...)
}
