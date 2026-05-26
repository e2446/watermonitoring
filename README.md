# sIndCon Real-Time Water Meter Dashboard

## Requirements
- Node.js 14 or higher
- Internet connection to sindconiot.com

## Setup & Run

1. Open a terminal / command prompt
2. Go to this folder:
   ```
   cd sindcon-dashboard
   ```
3. Start the server:
   ```
   node server.js
   ```
4. Open your browser and go to:
   ```
   http://localhost:3000
   ```

That's it! The dashboard will:
- Auto-login to sIndCon
- Fetch all nodes every 60 seconds
- Show live data with battery bars, valve status, RSSI signal

## Troubleshooting

**"Cannot reach proxy server"** → Make sure `node server.js` is running in your terminal

**"Login failed"** → The password may have changed. Update `CONFIG.username` and `CONFIG.password` in server.js

**Data shows but fields are blank** → Open http://localhost:3000/api/nodes in your browser and send a screenshot to check the raw data format
