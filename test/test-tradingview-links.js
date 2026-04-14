const https = require('https');

// Test configuration
const TIMEOUT = 5000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Sample crypto pairs from Binance
const testPairs = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'UNIUSDT',
  'LTCUSDT',
  'ATOMUSDT',
  'NEARUSDT'
];

function checkTradingViewLink(symbol) {
  return new Promise((resolve, reject) => {
    const tvSymbol = `BINANCE:${symbol}`;
    const url = `https://www.tradingview.com/chart/?symbol=${tvSymbol}`;
    
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT
    }, (res) => {
      const success = res.statusCode === 200;
      resolve({
        symbol: symbol,
        tvSymbol: tvSymbol,
        url: url,
        status: res.statusCode,
        success: success
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${symbol}`));
    });
    
    req.on('error', (err) => {
      reject(err);
    });
  });
}

async function runTests() {
  console.log('🧪 Testing TradingView Links for Crypto Scanner\n');
  console.log(`Testing ${testPairs.length} sample crypto pairs...\n`);
  
  let passed = 0;
  let failed = 0;
  const failures = [];
  
  for (const symbol of testPairs) {
    try {
      const result = await checkTradingViewLink(symbol);
      
      if (result.success) {
        console.log(`✅ ${symbol.padEnd(15)} ${result.tvSymbol.padEnd(25)} → ${result.status}`);
        passed++;
      } else {
        console.log(`❌ ${symbol.padEnd(15)} ${result.tvSymbol.padEnd(25)} → ${result.status}`);
        failed++;
        failures.push(result);
      }
      
      // Rate limiting: 100ms delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (err) {
      console.log(`❌ ${symbol.padEnd(15)} BINANCE:${symbol.padEnd(25)} → ERROR: ${err.message}`);
      failed++;
      failures.push({ symbol: symbol, error: err.message });
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Test Results:`);
  console.log(`   Passed: ${passed}/${testPairs.length}`);
  console.log(`   Failed: ${failed}/${testPairs.length}`);
  
  if (failures.length > 0) {
    console.log('\n❌ Failed Links:');
    failures.forEach(f => {
      console.log(`   - ${f.symbol}: ${f.status || f.error}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All TradingView links are valid!');
    process.exit(0);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
