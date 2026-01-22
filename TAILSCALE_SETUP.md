# Tailscale Remote Access Setup

Access your mining dashboard from anywhere in the world - securely and easily!

## What is Tailscale?

Tailscale creates a secure, private network (VPN) between your devices. It's like all your devices are on the same local network, even when you're away from home.

**Benefits:**
- ✅ **Free** for personal use (up to 100 devices)
- ✅ **Secure** - End-to-end encrypted, zero-trust network
- ✅ **Easy** - No port forwarding, no firewall configuration
- ✅ **Fast** - Direct peer-to-peer connections when possible
- ✅ **Works anywhere** - Cellular data, public WiFi, anywhere with internet

---

## Quick Setup (5 Minutes)

### Step 1: Install Tailscale on Raspberry Pi

**Option A: Use the automated script** (Recommended)

On your Mac, transfer and run the installation script:

```bash
# Navigate to your project
cd ~/path/to/home-mining-fleet-manager

# Transfer script to Pi and run it
scp install-tailscale.sh pi_user@pi_ip_address:~/
ssh pi_user@pi_ip_address 'chmod +x install-tailscale.sh && ./install-tailscale.sh'
```

The script will:
1. Install Tailscale
2. Prompt you to authenticate (opens a browser or shows a URL)
3. Show you your Tailscale IP address
4. Optionally set a friendly hostname

**Option B: Manual installation**

SSH into your Raspberry Pi:
```bash
ssh pi_user@pi_ip_address
```

Then run:
```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Start and authenticate
sudo tailscale up

# Get your Tailscale IP
tailscale ip -4
```

**During authentication:**
- You'll see a URL like: `https://login.tailscale.com/a/xxxxx`
- Open it in a browser (on any device)
- Sign in with Google, Microsoft, or GitHub
- Approve the device

### Step 2: Install Tailscale on Your Devices

Install Tailscale on the devices you want to access your dashboard from:

**iPhone/iPad:**
1. Open App Store
2. Search for "Tailscale"
3. Install and open
4. Sign in with the SAME account you used for the Pi

**Android:**
1. Open Google Play Store
2. Search for "Tailscale"
3. Install and open
4. Sign in with the SAME account

**Mac:**
```bash
brew install --cask tailscale
# Or download from: https://tailscale.com/download/mac
```

**Windows:**
Download from: https://tailscale.com/download/windows

**Linux:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

### Step 3: Get Your Tailscale IP

On your Raspberry Pi:
```bash
tailscale ip -4
```

Example output: `100.90.123.45`

### Step 4: Access Your Dashboard

From any device with Tailscale installed and connected:

**Using Tailscale IP:**
```
http://100.90.123.45:5001
```
(Replace with your actual Tailscale IP)

**Using hostname (if you set one):**
```
http://mining-dashboard:5001
```

---

## Setting a Friendly Hostname

Instead of remembering an IP like `100.90.123.45`, set a name:

```bash
# On Raspberry Pi
sudo tailscale set --hostname mining-dashboard
```

Now access via: `http://mining-dashboard:5001`

---

## Using Tailscale

### On iPhone/Android

1. Open Tailscale app
2. Make sure the toggle is ON (connected)
3. Open Safari/Chrome
4. Go to: `http://YOUR_TAILSCALE_IP:5001` or `http://mining-dashboard:5001`

**Pro Tip:** Save it as a bookmark or add to home screen!

### On Mac/PC

1. Ensure Tailscale is running (icon in menu bar/system tray)
2. Open any browser
3. Go to: `http://YOUR_TAILSCALE_IP:5001` or `http://mining-dashboard:5001`

### Checking Connection Status

**On Raspberry Pi:**
```bash
# Show status and list of connected devices
tailscale status

# Show your Tailscale IPs
tailscale ip

# Ping another device
tailscale ping YOUR_PHONE
```

**On your phone/computer:**
- Open Tailscale app
- You should see all devices including "raspberrypi" or "mining-dashboard"
- Green dot = online, grey = offline

---

## Troubleshooting

### "Connection refused" or dashboard doesn't load

**Check if Tailscale is running on Pi:**
```bash
ssh pi_user@pi_ip_address 'tailscale status'
```

**Check if fleet manager is running:**
```bash
ssh pi_user@pi_ip_address 'sudo systemctl status fleet-manager'
```

**Verify port 5001 is listening:**
```bash
ssh pi_user@pi_ip_address 'sudo netstat -tlnp | grep 5001'
```

### Can't see Raspberry Pi in Tailscale devices list

**On Raspberry Pi, restart Tailscale:**
```bash
sudo tailscale down
sudo tailscale up
```

**Check authentication:**
```bash
tailscale status
# Should show "logged in" not "logged out"
```

### Slow connection

Tailscale tries to establish direct peer-to-peer connections but may fall back to relay servers.

**Check connection type:**
```bash
tailscale status
# Look for "relay" vs "direct" in connection details
```

**To improve speed:**
- Ensure both devices have good internet connections
- Check if your home router allows UDP hole punching (most do)
- Try disabling VPN/firewall on your phone temporarily

### Dashboard loads but data doesn't update

This is a dashboard issue, not Tailscale. Check:
```bash
ssh pi_user@pi_ip_address 'sudo journalctl -u fleet-manager -n 50'
```

---

## Security Best Practices

### Tailscale Security Features

Tailscale is already very secure by default:
- ✅ End-to-end encrypted
- ✅ Zero-trust authentication
- ✅ No ports opened on your router
- ✅ Direct peer-to-peer when possible

### Additional Security (Optional)

**1. Enable Tailscale ACLs (Access Control Lists)**

Go to https://login.tailscale.com/admin/acls and restrict which devices can access your Pi:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["your-phone", "your-laptop"],
      "dst": ["mining-dashboard:*"]
    }
  ]
}
```

**2. Enable MFA on Tailscale Account**

Go to https://login.tailscale.com/admin/settings/security

**3. Monitor Access**

```bash
# On Raspberry Pi - see who's connected
tailscale status
```

---

## Advanced Features

### Share Dashboard with Family/Team

**Option 1: Invite to your Tailscale network**
1. Go to https://login.tailscale.com/admin/machines
2. Click "Share"
3. Send invite link

**Option 2: Share a specific device**
```bash
# On Raspberry Pi
sudo tailscale share <DEVICE_NAME>
```

### Auto-start Tailscale on Boot

This should already be enabled, but verify:

```bash
# On Raspberry Pi
sudo systemctl enable --now tailscaled
sudo systemctl status tailscaled
```

### Use Tailscale DNS Names

Enable MagicDNS in Tailscale admin: https://login.tailscale.com/admin/dns

Then access via: `http://mining-dashboard:5001` (no IP needed!)

### Exit Nodes (Access Home Network Resources)

Make your Pi an exit node to access other devices on your home network:

```bash
# On Raspberry Pi
sudo tailscale up --advertise-exit-node

# On your phone/laptop, enable exit node in Tailscale app settings
```

Now you can access other local devices (like your miners directly) via their local IPs!

---

## Cost

**Free tier includes:**
- Up to 100 devices
- All security features
- Unlimited users on personal network
- Community support

**Paid tier ($5/user/month):**
- Unlimited devices
- Advanced ACLs
- Priority support
- SSO integration

For home mining, the free tier is more than enough!

---

## Useful Commands Reference

```bash
# Check status
tailscale status

# Show IP addresses
tailscale ip

# Restart Tailscale
sudo tailscale down
sudo tailscale up

# Check if Tailscale service is running
sudo systemctl status tailscaled

# View Tailscale logs
sudo journalctl -u tailscaled -f

# Ping another Tailscale device
tailscale ping YOUR_DEVICE_NAME

# See network routes
tailscale status --json | jq .Self.AllowedIPs

# Log out (disconnect)
sudo tailscale logout

# Uninstall Tailscale (if needed)
sudo apt remove tailscale
```

---

## Comparing to Other Options

| Feature | Tailscale | Port Forwarding | ngrok | SSH Tunnel |
|---------|-----------|----------------|-------|------------|
| Setup difficulty | ⭐⭐ Easy | ⭐⭐⭐ Medium | ⭐⭐ Easy | ⭐⭐⭐⭐ Hard |
| Security | ✅ Excellent | ❌ Risky | ✅ Good | ✅ Excellent |
| Mobile friendly | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| Cost | Free | Free | Free (limited) | Free |
| Persistent | ✅ Always on | ✅ Always on | ❌ Restarts | ❌ Manual |
| No router config | ✅ Yes | ❌ No | ✅ Yes | ❌ No |

**Tailscale wins for ease + security + reliability!**

---

## FAQ

**Q: Does this expose my dashboard to the internet?**
A: No! Only devices authenticated to your Tailscale network can access it.

**Q: Will this slow down my internet?**
A: No, Tailscale is peer-to-peer when possible, so traffic doesn't go through servers.

**Q: Can I use this on cellular data?**
A: Yes! Tailscale works on any internet connection.

**Q: What if I lose my phone?**
A: Remove the device from https://login.tailscale.com/admin/machines

**Q: Does this work if my Raspberry Pi reboots?**
A: Yes, Tailscale starts automatically on boot.

**Q: Can I still access via local IP (e.g., 192.168.1.100:5001) when home?**
A: Yes! Local access continues to work normally.

**Q: How many devices can I connect?**
A: Free tier: 100 devices. More than enough for personal use!

---

## Getting Help

- **Tailscale Documentation:** https://tailscale.com/kb/
- **Tailscale Status Page:** https://status.tailscale.com/
- **Community Forum:** https://forum.tailscale.com/

---

## Summary

After setup, accessing your mining dashboard remotely is as simple as:

1. Open Tailscale app on your phone (make sure it's connected)
2. Open browser
3. Go to `http://mining-dashboard:5001`
4. View your mining stats from anywhere!

**No port forwarding, no complicated networking, no security risks. Just works.** ✨
