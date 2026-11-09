.PHONY: up down logs build dev shell tunnel

up:
	docker compose up -d --build

tunnel:
	docker compose --profile tunnel up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

build:
	docker compose build

dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

shell:
	docker compose exec scratchpad sh
