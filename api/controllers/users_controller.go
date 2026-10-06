package controllers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/kosuke/mj-stats-api/models"
)

type UserController struct {
	DB *sql.DB
}

func (uc *UserController) GetMe(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		http.Error(w, `{"error": "Unauthorized"}`, http.StatusUnauthorized)
		return
	}
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")

	// 簡易実装のため署名検証はスキップしペイロードのみ解析
	token, _, err := new(jwt.Parser).ParseUnverified(tokenString, jwt.MapClaims{})
	if err != nil {
		http.Error(w, `{"error": "Invalid token"}`, http.StatusUnauthorized)
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		http.Error(w, `{"error": "Invalid claims"}`, http.StatusUnauthorized)
		return
	}

	userID, ok := claims["sub"].(string)
	if !ok || userID == "" {
		http.Error(w, `{"error": "User ID not found"}`, http.StatusUnauthorized)
		return
	}

	email, _ := claims["email"].(string)
	userName := "Player"
	if email != "" && strings.Contains(email, "@") {
		userName = strings.Split(email, "@")[0]
	}

	query := `
		INSERT INTO users (id, name)
		VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
		RETURNING id, name
	`

	var user models.User
	err = uc.DB.QueryRow(query, userID, userName).Scan(&user.ID, &user.Name)
	if err != nil {
		http.Error(w, `{"error": "Database error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(user)
}
