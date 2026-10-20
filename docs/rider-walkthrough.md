# Rider setup walkthrough (Intel Mac)

For you, running a rider through first-time setup. About 10 minutes. Each step says what the rider should **see**, so you know it worked before moving on.

**What you give them:** `CyclingOS-Zwift-Link-Mac-Intel.zip` (39 MB, via Google Drive). Nothing else: no installs, no Terminal commands.

---

## Before you start (check these)

- [ ] Intel Mac, macOS 11 or newer, **with Zwift installed on that same Mac**
- [ ] Their phone has the CyclingOS app installed, and is on the **same home Wi-Fi** as the Mac (not a guest network)
- [ ] They know their **Zwift email and password**. If they normally sign in to Zwift with Google, Apple or Facebook, they must first set a Zwift password at zwift.com.
- [ ] The official **Zwift Companion app is closed** on their phone (it can't share the connection)

---

## Part 1: Install (once)

1. **Download and unzip.** Download the zip from Drive and double-click it. Drag the folder **CyclingOS Zwift Link** onto the **Desktop**.
2. **First open.** Open the folder. **Right-click** (or Control-click) **Start Zwift Link** and choose **Open**, then click **Open** again.
   - *Sees:* a Terminal window starting "CyclingOS Zwift Link… Leave this window open". The first start can take up to a minute.
   - *No "Open" button?* (newer macOS) Click **Done**. Go to **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** next to "Start Zwift Link", enter the Mac password, click **Open**.
   - If asked to let Terminal access the Desktop, click **OK**.
3. **Allow connections.** If macOS asks whether **"node"** may accept incoming connections, click **Allow**. (Clicking Deny breaks the phone link. Fix: System Settings → Network → Firewall → Options → set *node* to *Allow*.)
   - *Sees:* a web page called **CyclingOS Zwift Link** opens in the browser. This is the *dashboard*. **Keep the Terminal window open** for the whole ride.

## Part 2: Sign in to Zwift (once)

4. In the dashboard, under **Zwift account**, type their Zwift email and password and click **Save & connect**.
   - *Sees:* "Connected as *their name*". The checklist item **Signed in to Zwift** turns green.
   - *"Zwift rejected the email or password"*: re-type carefully, or set a Zwift password at zwift.com (see checklist above).

## Part 3: A ride

5. **Open Zwift** and start a ride. Pedalling isn't needed just to connect.
   - *Sees:* **Zwift game connected** and **Live data is fresh** turn green.
   - *Still "waiting" after a minute?* Quit Zwift completely (**Cmd+Q**), open it again and start a ride.
6. **Connect the phone** (same Wi-Fi). Open the CyclingOS app → **Zwift live** → choose **CyclingOS Zwift (…)** from the list → type the **pairing code** shown on the dashboard under **Phone pairing** (8 characters, like `K7QP-3MXD`; capitals or lowercase, dash optional).
   - *Sees:* the dashboard's **Phone connected** turns green ("1 over Wi-Fi"). The app shows the route name.
   - *Computer not in the list?* In the app choose **Enter address manually** and type the address shown in the dashboard's **Wi-Fi stream for the phone** line (looks like `http://192.168.0.35:8788`).
7. **Start the ride in the app** (**Start ride**) and ride. Power and heart rate need a trainer and strap connected to Zwift as usual.
8. **When finished:** **End ride** in the app. Then click the red **Stop everything** on the dashboard, or just close the Terminal window.

## Every time after that

Double-click **Start Zwift Link** (no right-click needed) → open Zwift and start a ride → open the app and connect → **Start ride**. The pairing code stays the same, and the app remembers the Mac.

---

## When something goes wrong

| Problem | Fix |
|---|---|
| Dashboard doesn't open | Open a browser and go to `http://127.0.0.1:8787` |
| "Zwift game connected" stays orange | Quit Zwift (Cmd+Q), reopen, start a ride. Check Zwift is on **this** Mac and the Companion app is closed. |
| Phone can't find the Mac | Same Wi-Fi? Not a guest network? Did they click **Allow** for "node"? Otherwise enter the address manually (step 6). |
| Pairing code rejected | Re-type it. **5 wrong tries lock the phone out for a minute.** If you reset it (dashboard → **New code**), every phone must enter the new code. |
| "Route recognised" is orange | Either the route isn't in the catalogue (the ride still records, without climb information), or the stored profile didn't match what Zwift reported and climb information was switched off for that ride. Send the log file. |
| Everything is stuck | Click **Stop everything**, then **Start again**. Still stuck: quit the monitor and reopen it. |
| Need help from you | At the bottom of the dashboard click **Show log file** and have them send you `monitor.log`. |

---

## Good to know

- **A green banner** ("All set. Data is flowing to your phone") means every checklist item is green. It stays orange on a route the catalogue doesn't have, or one whose stored profile disagreed with Zwift's altitude.
- **Their Zwift password** is stored only in that Mac's Keychain, and is used only to register the Mac with Zwift.
- **Updating:** send them a new zip. They replace the folder. Their login, pairing code and settings are kept, because those live outside the folder.
- **This is unofficial.** It uses Zwift's unofficial connection method, so a Zwift update could break it. If it suddenly stops working for everyone, that's the likely cause.
