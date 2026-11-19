package main

import (
	"context"
	"database/sql"
	"io"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/controllers"
	"github.com/kosuke/mj-stats-api/db"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/invites"
)

func router(database *sql.DB, verifier *auth.Verifier, origins []string, inviteConfig *invites.Config, limiter *controllers.AttemptLimiter, trustedProxies []string) *gin.Engine {
	guard := &auth.Guard{DB: database, Verifier: verifier}
	leagues := &controllers.LeagueController{DB: database}
	users := &controllers.UserController{Auth: guard}
	r := gin.New()
	r.RemoteIPHeaders = []string{"X-Forwarded-For"}
	if err := r.SetTrustedProxies(trustedProxies); err != nil {
		panic("invalid trusted proxy configuration")
	}
	// Default recovery/logger can expose request headers and panic/SQL details.
	r.Use(httpx.RequestMetadata(), gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, _ any) {
		httpx.Error(c, 500, "INTERNAL_ERROR", "処理に失敗しました", nil)
	}))
	r.Use(cors.New(cors.Config{AllowOrigins: origins, AllowMethods: []string{"GET", "POST", "PATCH", "OPTIONS"}, AllowHeaders: []string{"Authorization", "Content-Type"}, ExposeHeaders: []string{"X-Request-ID", "Retry-After"}, MaxAge: 10 * time.Minute}))
	r.GET("/api/health", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		defer cancel()
		if database.PingContext(ctx) != nil {
			httpx.Unavailable(c)
			return
		}
		c.JSON(200, gin.H{"status": "ok", "message": "MJ-Stats API & DB are running successfully"})
	})
	protected := r.Group("/api", guard.Middleware())
	protected.GET("/users/me", users.GetMe)
	protected.PATCH("/users/me", users.UpdateMe)
	normal := protected.Group("", guard.RequireProfile())
	normal.POST("/matches/calculate", controllers.RecordingRetired)
	normal.POST("/matches", controllers.RecordingRetired)
	normal.GET("/matches", leagues.LegacyHistory())
	normal.GET("/leagues/:league_id/matches", leagues.History())
	writes := &controllers.LeagueWrite{Auth: guard}
	normal.POST("/leagues/:league_id/matches/calculate", leagues.CalculateMatch())
	normal.POST("/leagues/:league_id/matches", writes.SaveMatch)
	normal.GET("/leagues/:league_id/matches/:match_id", leagues.MatchDetail())
	normal.POST("/leagues/:league_id/guests", writes.CreateGuest)
	normal.GET("/leagues/:league_id/participant-links", leagues.Links())
	normal.POST("/leagues/:league_id/participant-links", writes.RequestLink)
	normal.POST("/leagues/:league_id/participant-links/:id/approve", writes.ReviewLink(true))
	normal.POST("/leagues/:league_id/participant-links/:id/reject", writes.ReviewLink(false))
	normal.GET("/leagues", leagues.List)
	normal.POST("/leagues", (&controllers.LeagueCreator{Auth: guard}).Create)
	normal.GET("/leagues/:league_id", leagues.Detail())
	participation := &controllers.LeagueParticipation{Auth: guard, Limiter: limiter}
	normal.GET("/leagues/search", participation.Search)
	normal.POST("/leagues/resolve", participation.Resolve)
	normal.POST("/leagues/join-preview", participation.Preview)
	normal.POST("/leagues/:league_id/join", participation.Join)
	invitations := &controllers.LeagueInvites{Auth: guard, Config: inviteConfig}
	normal.GET("/leagues/:league_id/invites/current", invitations.Current())
	normal.POST("/leagues/:league_id/invites", invitations.Issue)
	normal.POST("/leagues/:league_id/invites/:id/revoke", invitations.Revoke)
	for _, list := range []string{"participants", "members", "rules", "seasons"} {
		normal.GET("/leagues/:league_id/"+list, leagues.Reference(list))
	}
	return r
}

func main() {
	_ = godotenv.Load()
	verifier, err := auth.NewVerifier(os.Getenv("SUPABASE_URL"))
	if err != nil {
		log.Fatal("Invalid authentication configuration")
	}
	origins := strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",")
	for i, origin := range origins {
		origin = strings.TrimSpace(origin)
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || strings.Contains(origin, "*") {
			log.Fatal("Invalid ALLOWED_ORIGINS")
		}
		origins[i] = origin
	}
	inviteConfig, err := invites.NewConfig(os.Getenv("APP_ORIGIN"), os.Getenv("INVITE_KEYS_JSON"), os.Getenv("INVITE_CURRENT_KEY_VERSION"))
	if err != nil {
		log.Fatal("Invalid invite configuration")
	}
	limiter, err := controllers.NewAttemptLimiter(os.Getenv("RATE_LIMIT_HASH_KEY"), os.Getenv("SEARCH_RATE_LIMIT"), os.Getenv("INVITE_LEAGUE_RATE_LIMIT"), os.Getenv("INVITE_IP_RATE_LIMIT"))
	if err != nil {
		log.Fatal("Invalid rate limit configuration")
	}
	var trustedProxies []string
	if raw := os.Getenv("TRUSTED_PROXY_CIDRS"); raw != "" {
		for _, value := range strings.Split(raw, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
			if err != nil || prefix.Bits() == 0 {
				log.Fatal("Invalid trusted proxy configuration")
			}
			trustedProxies = append(trustedProxies, prefix.Masked().String())
		}
	}
	database, err := db.NewDB()
	if err != nil {
		log.Fatal("Unable to connect to database")
	}
	defer database.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if limiter != nil {
		go controllers.PruneAttempts(ctx, database)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{Addr: ":" + port, Handler: router(database, verifier, origins, inviteConfig, limiter, trustedProxies), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Starting API on port %s", port)
	if server.ListenAndServe() != nil {
		log.Fatal("API server stopped")
	}
}
