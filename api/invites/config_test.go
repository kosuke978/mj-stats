package invites

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"testing"
)

func TestConfig(t *testing.T) {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		t.Fatal("generate test key")
	}
	key := base64.StdEncoding.EncodeToString(bytes[:])
	keys := fmt.Sprintf(`{ "1": %q }`, key)
	validOrigin := "https://web.example.test"
	if c, err := NewConfig("", "", ""); c != nil || err != nil {
		t.Fatal("absent keys should disable invite endpoints")
	}
	for _, test := range []struct{ name, origin, keys, version string }{
		{"missing origin", "", keys, "1"},
		{"credentials", "https://name@web.example.test", keys, "1"},
		{"path", validOrigin + "/page", keys, "1"},
		{"empty query", validOrigin + "?", keys, "1"},
		{"fragment", validOrigin + "#", keys, "1"},
		{"missing current", validOrigin, keys, ""},
		{"current unknown", validOrigin, keys, "2"},
		{"noncanonical version", validOrigin, keys, "01"},
		{"short key", validOrigin, `{"1":"YQ=="}`, "1"},
		{"duplicate version", validOrigin, fmt.Sprintf(`{ "1": %q, "1": %q }`, key, key), "1"},
		{"trailing JSON", validOrigin, keys + " {}", "1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if c, err := NewConfig(test.origin, test.keys, test.version); c != nil || err != errConfig {
				t.Fatal("expected a generic invalid configuration error")
			}
		})
	}
	c, err := NewConfig(validOrigin+"/", keys, "1")
	if err != nil || c.CurrentVersion() != 1 {
		t.Fatal("valid current key did not load")
	}
	hash := c.IssueHash("league", "invite")
	if c.IssueHash("another-league", "invite") == hash || c.IssueHash("league", "another-invite") == hash {
		t.Fatal("credential must be specific to league and invite")
	}
	if _, _, ok := c.Display("league", "invite", 1, hash, "000000000001"); !ok {
		t.Fatal("valid stored hash did not match its derived credential")
	}
	if _, _, ok := c.Display("league", "invite", 1, "wrong", "000000000001"); ok {
		t.Fatal("mismatched credential must remain undisclosed")
	}
}
