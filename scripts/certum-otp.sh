#!/bin/bash
# Generate TOTP code for Certum SimplySign login
# Usage: ./scripts/certum-otp.sh

SECRET="NJ2VE6KEM55GQUJSNBLVKVDJIFZXO2SEJZFUES2NGJ2XU3TFKFEQ===="

# Try system python paths that have pyotp
for PY in \
  /Applications/Xcode.app/Contents/Developer/usr/bin/python3 \
  /usr/bin/python3 \
  python3; do
  if "$PY" -c "import pyotp" 2>/dev/null; then
    PYTHON="$PY"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "pyotp not found. Install: pip3 install pyotp"
  exit 1
fi

"$PYTHON" -c "
import pyotp, time
totp = pyotp.TOTP('$SECRET', digest='sha256', digits=6, interval=30)
code = totp.now()
remaining = 30 - (int(time.time()) % 30)
print(f'OTP: {code}  (valid for {remaining}s)')
"
