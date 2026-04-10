<h1 align="center">CrowdControl: TikTok Live Key Mapper</h1>

<p align="center">
  <strong>Automate your gameplay with TikTok Live gifts and interactions.</strong><br />
  A professional Windows bridge between TikTok Live and your favorite desktop applications.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/OS-Windows%2010%2F11-blue?style=for-the-badge&logo=windows" alt="OS Windows" />
  <img src="https://img.shields.io/badge/Node.js-18%2B-green?style=for-the-badge&logo=node.js" alt="Node version" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License MIT" />
</p>

---

## 🚀 Overview

**CrowdControl** is a powerful desktop automation tool designed for streamers. It monitors your TikTok Live stream for specific gifts or like milestones and instantly translates them into keyboard or mouse inputs. Originally optimized for **Rocket League**, it works with any Windows application that accepts standard inputs.


## ✨ Key Features

- 🎁 **Gift Mapping**: Map any TikTok gift to specific key presses with custom duration and cooldowns.
- ❤️ **Like Triggers**: trigger keyboard actions automatically every *N* likes.
- 📉 **Real-time Aggregation**: Intelligently handles rapid gift sequences to prevent input flooding.
- 📁 **Profile Management**: Save and switch between different mapping sets for different games easily.
- 🖥️ **Live Feed**: Monitor all incoming interactions and automation statuses through a sleek dashboard.
- ⚡ **AutoHotkey Integration**: Leverages AHK v2 for reliable, low-latency input simulation.

## 🛠️ Requirements

Before starting, ensure you have the following installed:
- **Windows 10 or 11**
- **Node.js (Version 18 or newer)**
- **AutoHotkey v2** (Download from [autohotkey.com](https://www.autohotkey.com/))

## 🏁 1-Minute Quick Start

Open an **Elevated PowerShell** (Right-click Start → Terminal Admin or PowerShell Admin) and run:

```powershell
New-Item -Path C:\apps -ItemType Directory -Force ;
Set-Location C:\apps ;
Invoke-WebRequest -Uri https://github.com/TrevorWade/CrowdControl/archive/refs/heads/main.zip -OutFile CrowdControl.zip ;
Expand-Archive -Path CrowdControl.zip -DestinationPath . -Force ;
Rename-Item -Path .\CrowdControl-main -NewName CrowdControl ;
Remove-Item .\CrowdControl.zip ;
Set-Location .\CrowdControl ;
.\run_first.bat ;
.\start_crowdcontrol.bat
```

## 📖 How to Use

1. **Targeting**: Set your **Target Window** keyword (e.g., `rocket league`). The app will only send keys when this window is active.
2. **Connect**: Enter your TikTok username and click **Connect**.
3. **Configure**:
   - Go to **Gift Mappings** to add your first trigger.
   - Use **Like Triggers** to set up milestone-based actions.
4. **Play**: Focus your game and let your community drive the action!

## 🔧 Troubleshooting

If things aren't working as expected, check these common fixes:

<details>
<summary>Inputs are not being sent to the game</summary>
Ensure the app is running as <b>Administrator</b> and that the game window is currently focused. High-integrity processes (like many games) require the sender to also have elevated permissions.
</details>

<details>
<summary>AutoHotkey was not found</summary>
If the app can't find AHK, edit `backend\.env` and manually set `AHK_PATH`.  
Example: `AHK_PATH=C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe`
</details>

<details>
<summary>UI is blank or stuck loading</summary>
Close the application completely and run `run_first.bat` to refresh dependencies, then relaunch with `start_crowdcontrol.bat`.
</details>

## 👨‍💻 Development & Build

For developers looking to contribute or customize the app:

```bash
# Terminal 1: Backend
cd backend
npm install
npm run dev

# Terminal 2: Frontend
cd frontend
npm install
npm run dev
```

### Production Build (Electron)
To create a standalone Windows installer:
```bash
cd frontend/electron
npm run build
```

## ⚖️ License

Distributed under the MIT License. See `LICENSE` for more information.

---
<p align="center">Built with ❤️ for the streaming community.</p>
