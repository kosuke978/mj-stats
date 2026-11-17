package models

import (
	"strings"
	"testing"
)

func TestNormalizeName(t *testing.T) {
	cases := []struct {
		in, out string
		valid   bool
	}{
		{"あ", "あ", true}, {strings.Repeat("あ", 30), strings.Repeat("あ", 30), true}, {strings.Repeat("あ", 31), "", false},
		{"　 A😀 あ 　", "A😀 あ", true}, {"Player", "Player", true}, {"", "", false}, {"　 ", "", false},
		{"\n名前", "", false}, {"名前\r", "", false}, {"名\t前", "", false}, {"名\u0085前", "", false}, {"名\u2028前", "", false}, {"名\u2029前", "", false},
		{"\u2007名前\u202f", "名前", true}, {"\ufeff名前\ufeff", "\ufeff名前\ufeff", true}, {"e\u0301", "e\u0301", true},
	}
	for _, c := range cases {
		out, err := NormalizeName(c.in)
		if (err == nil) != c.valid || out != c.out {
			t.Errorf("name fixture mismatch: %q", c.in)
		}
	}
}
