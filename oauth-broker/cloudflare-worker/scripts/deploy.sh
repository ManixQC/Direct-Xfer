#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v node >/dev/null || { echo 'Node.js 20+ est requis.' >&2; exit 1; }
npx --yes wrangler@4.94.0 whoami
DB_NAME=direct-xfer-oauth-broker
DB_ID="$(npx --yes wrangler@4.94.0 d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s).find(v=>v.name==='direct-xfer-oauth-broker');if(x)process.stdout.write(x.uuid||x.id||'')})")"
if [ -z "$DB_ID" ]; then
  # Laisser Cloudflare choisir automatiquement la localisation D1 par défaut.
  npx --yes wrangler@4.94.0 d1 create "$DB_NAME"
  DB_ID="$(npx --yes wrangler@4.94.0 d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s).find(v=>v.name==='direct-xfer-oauth-broker');if(x)process.stdout.write(x.uuid||x.id||'')})")"
fi
[ -n "$DB_ID" ] || { echo 'Impossible de déterminer identifiant D1.' >&2; exit 1; }
sed "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/g" wrangler.jsonc.example > wrangler.jsonc
npx --yes wrangler@4.94.0 d1 migrations apply "$DB_NAME" --remote

worker_exists() {
  set +e
  npx --yes wrangler@4.94.0 deployments list --json >/dev/null 2>&1
  local status=$?
  set -e
  [ "$status" -eq 0 ]
}

secret_names() {
  local output status
  set +e
  output="$(npx --yes wrangler@4.94.0 secret list --format json 2>/dev/null)"; status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    if worker_exists; then
      echo 'Impossible de lire les secrets du Worker existant. Arrêt pour éviter toute rotation accidentelle de BROKER_DATA_KEY.' >&2
      return 1
    fi
    return 0
  fi
  printf '%s' "$output" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);for(const v of x)console.log(v.name||'')})"
}

secure_json_file() {
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  printf '%s' "$file"
}

deploy_with_secrets() {
  local cid="$1" csecret="$2" key="$3" file output status
  file="$(secure_json_file)"
  GOOGLE_CLIENT_ID="$cid" GOOGLE_CLIENT_SECRET="$csecret" BROKER_DATA_KEY="$key" node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET,BROKER_DATA_KEY:process.env.BROKER_DATA_KEY}))" "$file"
  set +e
  output="$(npx --yes wrangler@4.94.0 deploy --secrets-file "$file" 2>&1)"; status=$?
  set -e
  rm -f "$file"
  printf '%s\n' "$output"
  return "$status"
}

credential_count() {
  local output status
  set +e
  output="$(npx --yes wrangler@4.94.0 d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) AS count FROM credentials" --json 2>/dev/null)"; status=$?
  set -e
  [ "$status" -eq 0 ] || { echo 'Impossible de vérifier les credentials D1 existants.' >&2; return 1; }
  printf '%s' "$output" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);const first=Array.isArray(x)?x[0]:x;const r=first&&Array.isArray(first.results)?first.results[0]:null;const n=Number(r&&r.count);if(!Number.isFinite(n))process.exit(2);process.stdout.write(String(n))})"
}

set_google_secrets() {
  local cid="$1" csecret="$2" file output status
  file="$(secure_json_file)"
  GOOGLE_CLIENT_ID="$cid" GOOGLE_CLIENT_SECRET="$csecret" node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET}))" "$file"
  set +e
  output="$(npx --yes wrangler@4.94.0 secret bulk "$file" 2>&1)"; status=$?
  set -e
  rm -f "$file"
  printf '%s\n' "$output"
  return "$status"
}

SECRETS="$(secret_names)"
HAS_DATA_KEY=0
HAS_GOOGLE_ID=0
HAS_GOOGLE_SECRET=0
if grep -qx 'BROKER_DATA_KEY' <<<"$SECRETS"; then
  HAS_DATA_KEY=1
fi
if grep -qx 'GOOGLE_CLIENT_ID' <<<"$SECRETS"; then
  HAS_GOOGLE_ID=1
fi
if grep -qx 'GOOGLE_CLIENT_SECRET' <<<"$SECRETS"; then
  HAS_GOOGLE_SECRET=1
fi

if [ "$HAS_DATA_KEY" -eq 0 ]; then
  echo 'Premier déploiement : création de la clé de chiffrement persistante...'
  BROKER_DATA_KEY="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
  DEPLOY_OUTPUT="$(deploy_with_secrets 'bootstrap.disabled.apps.googleusercontent.com' 'bootstrap.disabled' "$BROKER_DATA_KEY")"
  printf '%s\n' "$DEPLOY_OUTPUT"
else
  echo 'BROKER_DATA_KEY existante détectée : elle sera conservée.'
  if [ "$HAS_GOOGLE_ID" -eq 0 ] || [ "$HAS_GOOGLE_SECRET" -eq 0 ]; then
    set_google_secrets 'bootstrap.disabled.apps.googleusercontent.com' 'bootstrap.disabled'
  fi
  DEPLOY_OUTPUT="$(npx --yes wrangler@4.94.0 deploy 2>&1)"
  printf '%s\n' "$DEPLOY_OUTPUT"
fi

BROKER_URL="$(printf '%s\n' "$DEPLOY_OUTPUT" | grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' | tail -n1 || true)"
if [ -z "$BROKER_URL" ] && [ -f deployment-result.txt ]; then
  BROKER_URL="$(sed -n 's/^DIRECT_XFER_OAUTH_BROKER_URL=//p' deployment-result.txt | head -n1)"
fi
[ -n "$BROKER_URL" ] || { echo 'URL workers.dev introuvable.' >&2; exit 1; }
BROKER_URL="${BROKER_URL%/}"
CALLBACK="$BROKER_URL/v1/google/callback"
echo "Broker public : $BROKER_URL"
echo "Callback Google : $CALLBACK"

INFO="$(curl -fsS "$BROKER_URL/v1/info" 2>/dev/null || true)"
GOOGLE_READY=0
if [ -n "$INFO" ]; then
  if printf '%s' "$INFO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const x=JSON.parse(s);process.exit(x.google&&x.storage!==false?0:1)}catch{process.exit(1)}})"; then
    GOOGLE_READY=1
  fi
fi

if [ "$GOOGLE_READY" -eq 1 ]; then
  read -r -p 'Google est déjà configuré. Conserver les identifiants actuels ? [O/n] ' KEEP
  if [[ -z "$KEEP" || "$KEEP" =~ ^[OoYy]$ ]]; then
    echo 'Identifiants Google existants conservés.'
  else
    GOOGLE_READY=0
  fi
fi

if [ "$GOOGLE_READY" -eq 0 ]; then
  EXISTING_CREDENTIALS="$(credential_count)"
  if [ "$EXISTING_CREDENTIALS" -gt 0 ] && [ "${DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE:-0}" != "1" ]; then
    echo "Refus de remplacer le client Google : $EXISTING_CREDENTIALS credential(s) broker existent déjà." >&2
    echo 'Conservez les identifiants actuels ou définissez explicitement DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE=1 après avoir planifié la reconnexion des remotes.' >&2
    exit 1
  fi
  echo "Créez un client OAuth Google 'Application Web' avec ce callback :"
  echo "$CALLBACK"
  read -r -p 'Appuyez Entrée quand prêt... ' _
  read -r -p 'Google Web Client ID: ' GOOGLE_CLIENT_ID
  read -r -s -p 'Google Web Client Secret: ' GOOGLE_CLIENT_SECRET; echo
  [[ "$GOOGLE_CLIENT_ID" =~ ^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$ ]] || { echo 'Client ID invalide.' >&2; exit 1; }
  [ -n "$GOOGLE_CLIENT_SECRET" ] || { echo 'Client Secret requis.' >&2; exit 1; }
  set_google_secrets "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET"
  DEPLOY_OUTPUT="$(npx --yes wrangler@4.94.0 deploy 2>&1)"
  printf '%s\n' "$DEPLOY_OUTPUT"
fi

INFO="$(curl -fsS "$BROKER_URL/v1/info")"
printf '%s' "$INFO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);if(!x.google||x.storage===false)process.exit(1)})"
printf 'DIRECT_XFER_OAUTH_BROKER_URL=%s\nGOOGLE_REDIRECT_URI=%s\n' "$BROKER_URL" "$CALLBACK" > deployment-result.txt
echo "Broker OAuth PUBLIC actif : $BROKER_URL"
