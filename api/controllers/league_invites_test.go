package controllers

import (
	"testing"
	"time"
)

func TestInviteExpirationBoundary(t *testing.T) {
	expiry := time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC)
	i := invite{ExpiresAt: expiry}
	if i.state(expiry.Add(-time.Microsecond)) != "active" || i.state(expiry) != "expired" ||
		i.state(expiry.Add(time.Microsecond)) != "expired" {
		t.Fatal("invitation validity must end at the exact expiry instant")
	}
	i.RevokedAt = &expiry
	if i.state(expiry) != "revoked" {
		t.Fatal("revocation must take precedence over expiration")
	}
}
