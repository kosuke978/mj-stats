package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/gin-gonic/gin"
)

type APIError struct {
	Code        string            `json:"code"`
	Message     string            `json:"message"`
	FieldErrors map[string]string `json:"field_errors,omitempty"`
	RequestID   string            `json:"request_id"`
}

func Error(c *gin.Context, status int, code, message string, fields map[string]string) {
	id, _ := c.Get("request_id")
	requestID, _ := id.(string)
	c.AbortWithStatusJSON(status, gin.H{"error": APIError{code, message, fields, requestID}})
}

func Unauthenticated(c *gin.Context) {
	c.Header("WWW-Authenticate", "Bearer")
	Error(c, http.StatusUnauthorized, "UNAUTHENTICATED", "ログインし直してください", nil)
}

func Unavailable(c *gin.Context) {
	Error(c, http.StatusServiceUnavailable, "TEMPORARILY_UNAVAILABLE", "一時的に利用できません。時間をおいて再試行してください", nil)
}

// Do not log request URLs, headers, bodies, SQL errors, or tokens.
func RequestMetadata() gin.HandlerFunc {
	return func(c *gin.Context) {
		var bytes [16]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			Error(c, 500, "INTERNAL_ERROR", "処理に失敗しました", nil)
			return
		}
		id := hex.EncodeToString(bytes[:])
		c.Set("request_id", id)
		c.Header("X-Request-ID", id)
		c.Header("Cache-Control", "private, no-store")
		c.Next()
	}
}
