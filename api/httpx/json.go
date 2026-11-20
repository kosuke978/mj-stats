package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// Decode accepts one object, rejects duplicate/unknown fields and caps the body.
func Decode(c *gin.Context, dst any) bool {
	media, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || media != "application/json" {
		Error(c, 415, "UNSUPPORTED_MEDIA_TYPE", "JSON形式で送信してください", nil)
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			Error(c, 413, "PAYLOAD_TOO_LARGE", "入力が大きすぎます", nil)
		} else {
			Invalid(c)
		}
		return false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' || !validUnicode(body) || !uniqueFields(json.NewDecoder(bytes.NewReader(body))) || !exactFields(body, reflect.TypeOf(dst)) {
		Invalid(c)
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		Invalid(c)
		return false
	}
	if dec.Decode(new(any)) != io.EOF {
		Invalid(c)
		return false
	}
	return true
}

// encoding/json accepts case-insensitive struct fields and repairs invalid
// surrogate escapes. The public contract requires exact fields and Unicode.
func exactFields(raw json.RawMessage, typ reflect.Type) bool {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ == reflect.TypeFor[json.RawMessage]() {
		return true // The caller validates the raw field's type and presence.
	}
	switch typ.Kind() {
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			return false
		}
		allowed := map[string]reflect.Type{}
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			tag := strings.Split(f.Tag.Get("json"), ",")[0]
			if f.IsExported() && tag != "-" {
				if tag == "" {
					tag = f.Name
				}
				allowed[tag] = f.Type
			}
		}
		for name, value := range fields {
			field, ok := allowed[name]
			if !ok || !exactFields(value, field) {
				return false
			}
		}
	case reflect.Array, reflect.Slice:
		var values []json.RawMessage
		if json.Unmarshal(raw, &values) != nil {
			return false
		}
		for _, value := range values {
			if !exactFields(value, typ.Elem()) {
				return false
			}
		}
	}
	return true
}

func validUnicode(body []byte) bool {
	if !utf8.Valid(body) {
		return false
	}
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' {
			continue
		}
		i++
		if i >= len(body) {
			return false
		}
		if body[i] != 'u' {
			continue
		}
		if i+4 >= len(body) {
			return false
		}
		r, err := strconv.ParseUint(string(body[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if r >= 0xdc00 && r <= 0xdfff {
			return false
		}
		if r >= 0xd800 && r <= 0xdbff {
			if i+6 >= len(body) || body[i+1] != '\\' || body[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(body[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

func Invalid(c *gin.Context) {
	Error(c, 400, "INVALID_INPUT", "入力内容を確認してください", map[string]string{"body": "必須項目・型・重複・余分な項目を確認してください"})
}

func uniqueFields(dec *json.Decoder) bool {
	token, err := dec.Token()
	if err != nil {
		return false
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return true
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for dec.More() {
			key, err := dec.Token()
			if err != nil {
				return false
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return false
			}
			seen[name] = true
			if !uniqueFields(dec) {
				return false
			}
		}
		end, err := dec.Token()
		return err == nil && end == json.Delim('}')
	case '[':
		for dec.More() {
			if !uniqueFields(dec) {
				return false
			}
		}
		end, err := dec.Token()
		return err == nil && end == json.Delim(']')
	default:
		return false
	}
}
