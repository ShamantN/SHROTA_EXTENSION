"""FastAPI Application entrypoint."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: ensure tables are created
    init_db()
    yield


app = FastAPI(
    title="YouTube Concert Auto-Bookmarking API",
    description="High-performance backend API for Indian Classical music segmentation and crowd consensus.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS configuration allowing browser extensions and web clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Cache-Control", "Surrogate-Key"],
)

app.include_router(router)


@app.get("/healthz")
def healthcheck():
    return {"status": "ok", "service": "concert-bookmarking-api"}
