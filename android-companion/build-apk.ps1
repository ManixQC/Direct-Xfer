$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
  .\gradlew.bat clean assembleRelease
  Write-Host "APK non signé : app\build\outputs\apk\release\app-release-unsigned.apk" -ForegroundColor Green
  Write-Host "Pour distribuer l'application, signe l'APK ou génère un AAB avec Android Studio." -ForegroundColor Yellow
}
finally { Pop-Location }
