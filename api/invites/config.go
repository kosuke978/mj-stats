// Package invites derives invitation credentials without storing plaintext.
package invites

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strconv"
	"strings"
)

type Config struct {
	origin  url.URL
	keys    map[int][]byte
	current int
}

var errConfig = errors.New("invalid invite configuration")
var alphabet = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

func NewConfig(origin, encodedKeys, currentVersion string) (*Config, error) {
	if encodedKeys == "" && currentVersion == "" {
		return nil, nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") ||
		u.User != nil || u.ForceQuery || u.RawQuery != "" || strings.ContainsAny(origin, "#*") ||
		(u.EscapedPath() != "" && u.EscapedPath() != "/") {
		return nil, errConfig
	}
	current := keyVersion(currentVersion)
	dec := json.NewDecoder(strings.NewReader(encodedKeys))
	if token, err := dec.Token(); err != nil || token != json.Delim('{') {
		return nil, errConfig
	}
	keys := make(map[int][]byte)
	for dec.More() {
		token, err := dec.Token()
		version, ok := token.(string)
		if err != nil || !ok {
			return nil, errConfig
		}
		number := keyVersion(version)
		var encoded string
		if number == 0 || keys[number] != nil || dec.Decode(&encoded) != nil {
			return nil, errConfig
		}
		key, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(key) < 32 || base64.StdEncoding.EncodeToString(key) != encoded {
			return nil, errConfig
		}
		keys[number] = key
	}
	if token, err := dec.Token(); err != nil || token != json.Delim('}') {
		return nil, errConfig
	}
	if _, err := dec.Token(); err != io.EOF || keys[current] == nil {
		return nil, errConfig
	}
	return &Config{origin: *u, keys: keys, current: current}, nil
}

func keyVersion(value string) int {
	number, err := strconv.ParseInt(value, 10, 32)
	if err != nil || number <= 0 || strconv.FormatInt(number, 10) != value {
		return 0
	}
	return int(number)
}

func (c *Config) CurrentVersion() int { return c.current }

func (c *Config) derive(leagueID, id string, version int) string {
	key := c.keys[version]
	if key == nil {
		return ""
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("mjstats.invite.v1\n" + leagueID + "\n" + id + "\n" + strconv.Itoa(version)))
	return alphabet.EncodeToString(mac.Sum(nil)[:10])
}

func (c *Config) IssueHash(leagueID, id string) string {
	return Hash(c.derive(leagueID, id, c.current))
}

func Hash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// Display checks the stored digest before revealing a regenerated credential.
func (c *Config) Display(leagueID, id string, version int, hash, group string) (code, link string, ok bool) {
	canonical := c.derive(leagueID, id, version)
	if canonical == "" || !hmac.Equal([]byte(Hash(canonical)), []byte(hash)) {
		return "", "", false
	}
	u := c.origin
	u.Path = "/join/" + group
	u.Fragment = "code=" + canonical
	return canonical[:4] + "-" + canonical[4:8] + "-" + canonical[8:12] + "-" + canonical[12:], u.String(), true
}

// NormalizeCode accepts only the ASCII Crockford alphabet, ignoring display
// hyphens and ASCII letter case. An empty result means the format is invalid.
func NormalizeCode(input string) string {
	var canonical [16]byte
	size := 0
	for _, ch := range []byte(strings.TrimSpace(input)) {
		if ch == '-' {
			continue
		}
		if ch >= 'a' && ch <= 'z' {
			ch -= 'a' - 'A'
		}
		if size == len(canonical) || !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", rune(ch)) {
			return ""
		}
		canonical[size] = ch
		size++
	}
	if size != len(canonical) {
		return ""
	}
	return string(canonical[:])
}
