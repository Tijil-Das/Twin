#!/usr/bin/env bash
# Quick launcher for the JioTv Max release CLI (Unix/Mac/Git Bash)
# Usage: ./run.sh [watch|status] [flags]
cd "$(dirname "$0")"
node --import tsx/esm src/index.ts "$@"
