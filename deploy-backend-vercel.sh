#!/bin/bash
# Deploy Derasa FastAPI backend to Vercel
# Run: bash deploy-vercel.sh

set -e
cd "$(dirname "$0")/derasa/backend"

echo "==> Deploying Derasa backend to Vercel..."
echo ""
echo "Step 1: Login (if not already)"
echo "  vercel login"
echo ""
echo "Step 2: Deploy"
echo "  vercel deploy --prod --yes"
echo ""
echo "After deploy, Vercel gives you a URL like:"
echo "  https://derasa-backend-xxxxxxx.vercel.app"
echo ""
echo "Step 3: Update content-config.json"
echo "  Edit derasa/www/content-config.json"
echo "  Set backendUrl to the Vercel URL above"
echo ""
echo "Step 4: Commit and push"
echo "  git add derasa/www/content-config.json"
echo "  git commit -m 'Derasa: update backend URL to production'"
echo "  git push"
echo ""
echo "Step 5: Verify"
echo "  curl https://<your-url>.vercel.app/api/packs"
echo "  curl https://<your-url>.vercel.app/api/health"
echo "  curl https://<your-url>.vercel.app/api/progress/aggregate"