# Crypto Scanner - OpenClaw Skill

An automated cryptocurrency scanner that monitors Binance markets and sends email alerts when assets meet specific technical criteria.

## Features

- **Multi-indicator scoring system** (max 9 points):
  - RSI < 25 (+1 point) - Oversold detection
  - Bollinger Band squeeze (+1) - Breakout imminent
  - MACD bullish crossover (+1) - Momentum shift
  - OBV rising (+2) - Accumulation detected
  - Price below VWAP (+1) - Below institutional fair value

- **Smart alerting**: Only sends emails when score ≥ 4/9
- **HTML email reports** with clickable TradingView chart links
- **Top 50 USDT pairs** by 24h volume on Binance
- **Automated scheduling** via cron (every 15 minutes)

## Requirements

- Node.js v14+
- `msmtp` configured for email sending
- `gog` CLI shim (included in setup)

## Installation

1. Copy the skill to your OpenClaw skills directory:
```bash
cp -r crypto-scanner ~/.npm-global/lib/node_modules/openclaw/skills/
```

2. Configure email recipient in `scripts/scan_crypto.cjs`:
```javascript
const EMAIL_TO = 'your-email@example.com';
```

3. Set up the `gog` email shim at `~/.local/bin/gog`:
```bash
#!/bin/bash
# Shim to redirect gog mail send calls to msmtp for OpenClaw
if [[ "$1" == "mail" && "$2" == "send" ]]; then
    shift 2
    SUBJECT=""
    BODY=""
    BODY_FILE=""
    TO=""
    while [[ "$#" -gt 0 ]]; do
        case $1 in
            --subject) SUBJECT="$2"; shift ;;
            --body) BODY="$2"; shift ;;
            --body-file) BODY_FILE="$2"; shift ;;
            --to) TO="$2"; shift ;;
        esac
        shift
    done
    
    if [[ -n "$BODY_FILE" && -f "$BODY_FILE" ]]; then
        BODY=$(cat "$BODY_FILE")
    fi
    
    echo -e "Subject: $SUBJECT\nContent-Type: text/html; charset=UTF-8\n\n$BODY" | msmtp -a default "$TO"
else
    echo "gog shim: Only 'mail send' is implemented."
    exit 1
fi
```

4. Make it executable:
```bash
chmod +x ~/.local/bin/gog
```

5. Add to crontab:
```bash
crontab -e
# Add this line:
*/15 * * * * /usr/bin/node /path/to/crypto-scanner/scripts/scan_crypto.cjs >> /path/to/logs/crypto-scanner.log 2>&1
```

## Usage

Manual run:
```bash
node scripts/scan_crypto.cjs
```

Check logs:
```bash
tail -f ~/.openclaw/workspace/logs/crypto-scanner.log
```

## Email Format

Alerts include:
- Asset symbol with TradingView link
- Composite score (out of 9)
- Current RSI value
- Current price
- List of triggered signals

## Scoring Thresholds

- **Score ≥ 4**: Email alert sent
- **Score = 3**: Logged only
- **Score < 3**: Skipped

## License

MIT

## Author

Created for OpenClaw AI assistant framework
