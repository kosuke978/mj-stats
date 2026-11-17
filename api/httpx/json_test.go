package httpx

import (
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStrictJSONContract(t *testing.T) {
	r := gin.New()
	r.Use(RequestMetadata())
	r.PATCH("/me", func(c *gin.Context) {
		var input struct {
			Name *string `json:"name"`
		}
		if Decode(c, &input) {
			c.Status(200)
		}
	})
	cases := []struct {
		body, content string
		status        int
	}{
		{`{"name":"😀"}`, "application/json", 200},
		{`{"name":"\ud83d\ude00"}`, "application/json", 200},
		{`{"name":"\ud800"}`, "application/json", 400},
		{`{"name":"\udfff"}`, "application/json", 400},
		{`{"name":"a","name":"b"}`, "application/json", 400},
		{`{"name":"a","Name":"b"}`, "application/json", 400},
		{`{"name":"a","id":"other"}`, "application/json", 400},
		{`{"name":"a"} {}`, "application/json", 400},
		{`[]`, "application/json", 400},
		{`{"name":123}`, "application/json", 400},
		{`{"name":"a"}`, "text/plain", 415},
		{strings.Repeat("x", (64<<10)+1), "application/json", 413},
	}
	for _, tc := range cases {
		req := httptest.NewRequest("PATCH", "/me", strings.NewReader(tc.body))
		req.Header.Set("Content-Type", tc.content)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Errorf("expected %d got %d", tc.status, w.Code)
		}
		if w.Header().Get("Cache-Control") != "private, no-store" {
			t.Error("cache policy")
		}
	}
}
