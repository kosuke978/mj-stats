package models

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

func NormalizeName(raw string) (string, error) {
	if !utf8.ValidString(raw) {
		return "", errors.New("invalid name")
	}
	for _, r := range raw {
		if unicode.Is(unicode.Cc, r) || r == '\u2028' || r == '\u2029' {
			return "", errors.New("invalid name")
		}
	}
	name := strings.TrimFunc(raw, unicode.IsSpace)
	count := utf8.RuneCountInString(name)
	if count < 1 || count > 30 {
		return "", errors.New("invalid name")
	}
	return name, nil
}
