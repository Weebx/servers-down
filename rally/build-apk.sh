#!/usr/bin/env bash
#
# Сборка APK «RALLY» без Gradle и без Android Studio — только aapt2 + javac(ecj) + d8 + apksigner.
#
# Нужны инструменты (пути можно переопределить переменными окружения):
#   AAPT2        — aapt2 для linux x64        (npm: aaptjs3  -> package/bin/x64/linux/aapt2)
#   ANDROID_JAR  — android.jar (API 34)       (npm: @drxiaozhi/minapk -> package/tools/android.jar)
#   D8_JAR       — d8.jar                     (npm: @drxiaozhi/minapk -> package/tools/d8.jar)
#   APKSIGNER    — apksigner.jar              (npm: @drxiaozhi/minapk -> package/tools/apksigner.jar)
#   ECJ          — ecj.jar (компилятор Java)  (npm: @drxiaozhi/minapk -> package/tools/ecj-*.jar)
#   JAVA         — java из любого JDK 8+
#
# Пример:
#   AAPT2=~/.tools/aapt2 JAVA=java D8_JAR=~/.tools/d8.jar ... ./build-apk.sh
#
set -euo pipefail

cd "$(dirname "$0")"

AAPT2="${AAPT2:-.tools/aapt2}"
ANDROID_JAR="${ANDROID_JAR:-.tools/android.jar}"
D8_JAR="${D8_JAR:-.tools/d8.jar}"
APKSIGNER="${APKSIGNER:-.tools/apksigner.jar}"
ECJ="${ECJ:-.tools/ecj.jar}"
JAVA="${JAVA:-java}"

APP_NAME="rally"
APP_ID="com.weebx.rally"
VERSION_NAME="1.0"
VERSION_CODE="1"
MIN_SDK=21
TARGET_SDK=34

BUILD="build"
OUT="dist"
KEYSTORE="android/rally.keystore"
KS_PASS="rally2026"
KEY_ALIAS="rally"

for f in "$AAPT2" "$ANDROID_JAR" "$D8_JAR" "$APKSIGNER" "$ECJ"; do
  [ -f "$f" ] || { echo "нет файла: $f (см. шапку скрипта)"; exit 1; }
done

echo "==> чистим $BUILD"
rm -rf "$BUILD"
mkdir -p "$BUILD/res" "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/assets/www" "$OUT"

echo "==> копируем игру в assets/www"
cp game/index.html game/game.js "$BUILD/assets/www/"

echo "==> aapt2 compile"
"$AAPT2" compile --dir android/res -o "$BUILD/res/"

echo "==> aapt2 link"
"$AAPT2" link \
  -o "$BUILD/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest android/AndroidManifest.xml \
  --java "$BUILD/gen" \
  -A "$BUILD/assets" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  "$BUILD"/res/*.flat

echo "==> javac (ecj)"
"$JAVA" -jar "$ECJ" \
  -source 8 -target 8 -nowarn -encoding UTF-8 \
  -cp "$ANDROID_JAR" \
  -d "$BUILD/classes" \
  $(find android/java "$BUILD/gen" -name '*.java')

echo "==> d8 (dex)"
"$JAVA" -cp "$D8_JAR" com.android.tools.r8.D8 \
  --release --min-api "$MIN_SDK" \
  --lib "$ANDROID_JAR" \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')

echo "==> упаковываем dex в APK"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
(cd "$BUILD/dex" && zip -q -9 ../unsigned.apk classes.dex)

echo "==> ключ для подписи"
if [ ! -f "$KEYSTORE" ]; then
  echo "    создаём $KEYSTORE (пароль: $KS_PASS, alias: $KEY_ALIAS)"
  "$JAVA" -cp "$(dirname "$JAVA")/../lib/tools.jar" sun.security.tools.keytool.Main >/dev/null 2>&1 || true
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storetype JKS \
    -storepass "$KS_PASS" \
    -keypass "$KS_PASS" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=RALLY, OU=Weebx, O=Weebx, L=Berlin, C=DE" >/dev/null
fi

echo "==> apksigner"
"$JAVA" -jar "$APKSIGNER" sign \
  --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --ks-key-alias "$KEY_ALIAS" \
  --min-sdk-version "$MIN_SDK" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$OUT/$APP_NAME.apk" "$BUILD/unsigned.apk"

echo "==> проверка подписи"
"$JAVA" -jar "$APKSIGNER" verify --verbose "$OUT/$APP_NAME.apk" | head -5

echo "==> проверка манифеста"
"$AAPT2" dump badging "$OUT/$APP_NAME.apk" 2>/dev/null | head -6 || true

ls -lh "$OUT/$APP_NAME.apk"
echo "готово: $(pwd)/$OUT/$APP_NAME.apk"
