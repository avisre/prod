# Running the deploy checks on the Windows PC

The checks that used to run on GitHub for every push now run before the push, on the PC when it is reachable and
on the Mac when it is not. This is the one-time setup of the PC. Written 2026-10-10; **not yet carried out or
tested on the PC**, so expect to adjust a step.

## On the PC (PowerShell, "Run as administrator")

```powershell
# 1. SSH server, started now and at every boot
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# 2. Git and Node 22
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

Close and reopen PowerShell (not as administrator), then:

```powershell
# 3. The code. The repository is private, so Git will ask you to sign in to GitHub once.
mkdir C:\dev; cd C:\dev
git clone https://github.com/avisre/prod.git
cd prod
git config receive.denyCurrentBranch ignore   # lets the Mac hand it a commit
npm ci
npm ci --prefix backend

# 4. What the Mac needs to know
whoami        # the user name
ipconfig      # the IPv4 address, e.g. 192.168.1.50
```

## Let the Mac in without a password

On the Mac, print its public key (create one first with `ssh-keygen -t ed25519` if the file is missing):

```sh
cat ~/.ssh/id_ed25519.pub
```

On the PC, paste that one line into the right file. For an administrator account Windows reads
`C:\ProgramData\ssh\administrators_authorized_keys`; for a standard account, `C:\Users\<you>\.ssh\authorized_keys`.

```powershell
# administrator account
Add-Content C:\ProgramData\ssh\administrators_authorized_keys "<the line from the Mac>"
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

## On the Mac

```sh
mkdir -p ~/.config/stockportfolio
cat > ~/.config/stockportfolio/predeploy.env <<'CONF'
PREDEPLOY_HOST=<user>@<pc address>
PREDEPLOY_DIR=C:/dev/prod
CONF
ssh <user>@<pc address> "node --version"      # must print a version with no password prompt
git -C ~/prod config core.hooksPath .githooks  # once; every worktree shares it
```

## Check it

```sh
node scripts/predeploy.js --list          # what would run for the current change, and why
sh scripts/predeploy-remote.sh origin/main..HEAD "$(git rev-parse HEAD)"
```

The first line of output names the machine that ran it. If the PC is off, it says so and runs on the Mac.

## Known unknowns on Windows

- Production runs Linux. A pass on Windows is weaker evidence than a pass on the Mac or Linux. Run
  `node scripts/predeploy.js --all` once on both machines and compare; a test that fails only on Windows should be
  fixed or the PC side moved into WSL.
- After `git pull` changes a lockfile, run the two `npm ci` commands again on the PC.
