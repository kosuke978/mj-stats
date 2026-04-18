package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/kosuke/mj-stats-api/controllers"
	"github.com/kosuke/mj-stats-api/db"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using system environment variables")
	}

	database, err := db.NewDB()
	if err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}
	defer func(database *sql.DB) {
		if closeErr := database.Close(); closeErr != nil {
			log.Printf("failed to close database: %v", closeErr)
		}
	}(database)

	matchController := controllers.NewMatchController(database)

	r := gin.Default()
	r.Use(cors.Default())

	r.GET("/api/health", func(c *gin.Context) {
		if err := database.Ping(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"status":  "error",
				"message": "Database connection failed",
				"error":   err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"message": "MJ-Stats API & DB are running successfully",
		})
	})

	r.POST("/api/matches/calculate", matchController.Calculate)
	r.POST("/api/matches", matchController.CreateMatch)
	r.GET("/api/matches", matchController.GetMatches)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Starting server on :%s\n", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
