# 🚀 Vercel + Supabase Deployment - Quick Start

Your project is now ready to deploy! Here's what I've done:

## ✅ Completed Setup

1. **Database Layer Updated** ✓
   - Changed from SQLite to PostgreSQL (fully compatible with Supabase)
   - Automatically creates schema on first deployment
   - Supports async/await operations

2. **Configuration Files Created** ✓
   - `DEPLOYMENT.md` - Complete step-by-step deployment guide
   - `.env.example` - Environment variables template
   - `vercel.json` - Vercel configuration
   - `.gitignore` - Git ignore rules
   - `db-sqlite.js` - Backup of original SQLite version

3. **Dependencies Updated** ✓
   - Added `pg` package for PostgreSQL connections
   - All packages installed locally

4. **Changes Pushed to GitHub** ✓
   - Repository: https://github.com/manikantasai17746-arch/DBMS_TEACHER_STUDENT_MATERIAL_SHARING_PORTAL

---

## 📋 Quick Deployment Steps

### 1️⃣ Create Supabase Project (5 minutes)
- Go to https://supabase.com
- Create a new project
- Copy your DATABASE_URL from Project Settings → Database

### 2️⃣ Create Vercel Project (5 minutes)
- Go to https://vercel.com
- Click "Add New" → "Project"
- Import your GitHub repository
- Set environment variables (see below)

### 3️⃣ Set These Environment Variables in Vercel

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Your Supabase connection string |
| `SESSION_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV` | `production` |
| `ADMIN_EMP_ID` | `mani@1774admin` (or your choice) |
| `ADMIN_PASSWORD` | Your secure password |
| `ADMIN_EMAIL` | Your email |
| `MAIL_USER` | Your Gmail address |
| `MAIL_APP_PASSWORD` | Gmail app password |
| `MAIL_FROM_NAME` | `EduVault` |

### 4️⃣ Deploy
- Click "Deploy" in Vercel
- Wait for build to complete (2-5 minutes)
- Visit your deployment URL
- Test with admin credentials

---

## 📖 Detailed Guide

**Full deployment guide is in**: `eduvault-maya-ui/DEPLOYMENT.md`

This includes:
- Supabase project setup
- Vercel project configuration
- Gmail app password setup
- Troubleshooting
- Database migration info
- File upload options
- Performance tips

---

## 🔐 Important Security Notes

1. **Change Default Admin Password**
   - Don't use `mani@1774` in production
   - Set a strong password in `ADMIN_PASSWORD`

2. **Generate SESSION_SECRET**
   - Run: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - Use this random value, not a memorable phrase

3. **Never Commit `.env` File**
   - Set variables in Vercel Settings instead
   - Only commit `.env.example`

4. **Gmail App Password**
   - Use app-specific password, not your main Gmail password
   - Enable 2-Factor Authentication: https://myaccount.google.com/apppasswords

---

## 📁 Key Files Modified

```
eduvault-maya-ui/
├── db.js                 (NEW) PostgreSQL version
├── db-sqlite.js          (NEW) Backup of original
├── package.json          (UPDATED) Added pg dependency
├── .env.example          (UPDATED) Added DATABASE_URL
├── .gitignore            (NEW) Git configuration
├── vercel.json           (UPDATED) Vercel settings
├── DEPLOYMENT.md         (NEW) Complete deployment guide
└── node_modules/         (UPDATED) pg package added
```

---

## 🧪 Test Locally (Optional)

To test with local PostgreSQL before deploying:

```bash
# 1. Install PostgreSQL locally or use Docker

# 2. Create .env file
cp .env.example .env

# 3. Set DATABASE_URL in .env
# Example: postgresql://postgres:password@localhost:5432/eduvault

# 4. Start server
npm start

# 5. Visit http://localhost:3000
```

---

## ⚡ Next Steps

1. Create Supabase account: https://supabase.com
2. Read DEPLOYMENT.md for detailed instructions
3. Create Vercel account: https://vercel.com
4. Import your GitHub repository to Vercel
5. Set environment variables
6. Click Deploy!

---

## 🆘 Troubleshooting

**"DATABASE_URL is not set"**
- Make sure you set it in Vercel environment variables
- Redeploy after setting

**"Connection timeout"**
- Verify DATABASE_URL is correct
- Check if Supabase project is running

**"Table does not exist"**
- Schema auto-creates on first deployment
- Check Vercel logs if issues

For more help, see `DEPLOYMENT.md` Troubleshooting section.

---

## 📞 Support

- Vercel Support: https://vercel.com/help
- Supabase Support: https://supabase.com/support
- Express.js Docs: https://expressjs.com/
- PostgreSQL Docs: https://www.postgresql.org/docs/

---

**You're all set! 🎉 Your project is ready for production deployment!**
