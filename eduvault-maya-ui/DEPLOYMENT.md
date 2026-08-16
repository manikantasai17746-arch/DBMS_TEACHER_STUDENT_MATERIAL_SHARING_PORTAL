# Deployment Guide: EduVault to Vercel + Supabase

This guide walks you through deploying the EduVault application to Vercel with Supabase as the database.

## Prerequisites

- GitHub account (for pushing code)
- Vercel account (free at https://vercel.com)
- Supabase account (free at https://supabase.com)
- Node.js 22.5+ installed locally

## Step 1: Create Supabase Project

1. Go to https://supabase.com and sign up/log in
2. Click "New Project"
3. Fill in the details:
   - **Project name**: `eduvault`
   - **Database password**: Create a strong password (save it!)
   - **Region**: Choose closest to your users
4. Wait for the project to be created (2-3 minutes)
5. Go to **Settings → Database → Connection Strings**
6. Copy the **URI** (PostgreSQL connection string)
   - It looks like: `postgresql://postgres:[PASSWORD]@[HOST]:[PORT]/postgres`
   - **Keep this safe!** This is your `DATABASE_URL`

## Step 2: Test Local Database Connection (Optional)

If you want to test locally first:

```bash
# Install dependencies
npm install

# Create .env file from template
cp .env.example .env

# Edit .env and set DATABASE_URL to your Supabase connection string
# Also update other environment variables as needed

# Start the server
npm start
```

The app will automatically create all tables on first run.

## Step 3: Push Code to GitHub

Your code is already on GitHub at:
```
https://github.com/manikantasai17746-arch/DBMS_TEACHER_STUDENT_MATERIAL_SHARING_PORTAL.git
```

If you made local changes, commit and push:
```bash
git add .
git commit -m "Update database for Supabase deployment"
git push origin main
```

## Step 4: Create Vercel Project

1. Go to https://vercel.com/dashboard
2. Click "Add New..." → "Project"
3. Select "Import Git Repository"
4. Paste your repository URL:
   ```
   https://github.com/manikantasai17746-arch/DBMS_TEACHER_STUDENT_MATERIAL_SHARING_PORTAL.git
   ```
5. Click "Import"
6. Configure project:
   - **Framework**: Node.js (should be auto-detected)
   - **Root Directory**: `eduvault-maya-ui/`
   - **Build Command**: `npm install` (default)
   - **Output Directory**: Leave blank
   - **Install Command**: `npm install` (default)

## Step 5: Set Environment Variables

After clicking "Import", you'll see the environment variables section:

1. Click "Environment Variables"
2. Add these variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | Your Supabase connection string | From Step 1 |
| `SESSION_SECRET` | Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | Required for production |
| `NODE_ENV` | `production` | |
| `ADMIN_EMP_ID` | `mani@1774admin` | Or change to your preferred ID |
| `ADMIN_PASSWORD` | Choose a strong password | **Change from default!** |
| `ADMIN_EMAIL` | Your email address | For admin account |
| `MAIL_USER` | Your Gmail address | For sending enrollment codes |
| `MAIL_APP_PASSWORD` | Gmail App Password | See below |
| `MAIL_FROM_NAME` | `EduVault` | Display name in emails |

### Generating Gmail App Password

If you don't have a Gmail App Password:

1. Go to https://myaccount.google.com/apppasswords
2. Enable 2-Step Verification if not already enabled
3. Select "Mail" and "Windows Computer" (or your device)
4. Google will generate a 16-character password
5. Use this password in `MAIL_APP_PASSWORD`

## Step 6: Deploy

1. After setting all environment variables, click "Deploy"
2. Wait for the deployment to complete (usually 2-5 minutes)
3. You'll see a success message and a deployment URL

## Step 7: Verify Deployment

1. Click the deployment URL
2. You should see the EduVault login page
3. Test with admin credentials:
   - **ID**: `mani@1774admin` (or your `ADMIN_EMP_ID`)
   - **Password**: Your `ADMIN_PASSWORD`

## Migration: SQLite to PostgreSQL

The code has been updated to use PostgreSQL instead of SQLite:

- **Old file**: `db-sqlite.js` (backup of original SQLite version)
- **New file**: `db.js` (PostgreSQL/Supabase version)

Key changes:
- Uses `pg` package for PostgreSQL connections
- All database operations now use async/await
- Connection pooling for better performance
- Automatic schema initialization on startup
- Full compatibility with Supabase

## File Upload Storage

The current setup stores uploaded files in the `/uploads` directory. For production with Vercel:

### Option 1: Vercel Blob Storage (Recommended)

Install Vercel Blob:
```bash
npm install @vercel/blob
```

Update `lib/storage.js` to use Blob Storage (contact admin for code changes).

### Option 2: Supabase Storage

Use Supabase's built-in storage:
1. Go to Supabase Dashboard → Storage
2. Create a bucket named `uploads`
3. Update `lib/storage.js` to use Supabase client

### Option 3: Local (Not Recommended for Vercel)

Vercel serverless functions don't have persistent storage. Local file uploads won't survive between deployments.

## Monitoring and Logs

### View Deployment Logs

1. Go to Vercel Dashboard
2. Select your project
3. Click "Deployments"
4. Click on a deployment
5. Click "Logs" to see build and runtime logs

### Database Logs (Supabase)

1. Go to Supabase Dashboard
2. Select your project
3. Go to "Database" → "Logs" to see query logs

## Troubleshooting

### "DATABASE_URL is not set"
- Make sure you set the `DATABASE_URL` environment variable in Vercel settings
- Redeploy after setting variables

### Connection timeout errors
- Verify your `DATABASE_URL` is correct
- Check if Supabase project is running
- Ensure Vercel's IP is whitelisted in Supabase (it should be by default)

### "table does not exist"
- The schema should auto-create on first deployment
- Check deployment logs for errors
- Manually run database initialization if needed

### File uploads failing
- Implement one of the cloud storage options above
- Local uploads won't work on Vercel

### Admin login not working
- Verify `ADMIN_EMP_ID`, `ADMIN_PASSWORD`, and `SESSION_SECRET` are set correctly
- Redeploy after changing environment variables
- Clear browser cookies if still having issues

## Database Backups

### Supabase Automatic Backups

Supabase automatically backs up your database daily. To restore:

1. Go to Supabase Dashboard → Backups
2. Select a backup point
3. Click "Restore"

### Manual Database Export

To export your database:

1. Go to Supabase Dashboard
2. Go to SQL Editor
3. Run: `pg_dump your_database > backup.sql`
4. Or use Supabase's backup feature

## Performance Tips

1. **Connection Pooling**: Already configured in `db.js`
2. **Database Indexes**: Already created for common queries
3. **Caching**: Consider adding Redis for session storage
4. **CDN**: Vercel automatically serves static files via CDN

## Cost Considerations

### Supabase Free Plan
- 500 MB database size
- 1 GB bandwidth per month
- Up to 100 concurrent connections
- Daily automated backups

### Vercel Free Plan
- Unlimited deployments
- Automatic HTTPS
- Serverless functions
- 6000 function invocations per month (free tier)

## Next Steps

1. **Custom Domain**: Add your domain to Vercel
2. **SSL Certificate**: Automatically provided by Vercel
3. **Monitoring**: Set up error tracking with Sentry
4. **Analytics**: Add user analytics
5. **Database Scaling**: Upgrade Supabase plan if needed

## Support

For issues:
1. Check Vercel logs
2. Check Supabase logs
3. Review this guide's troubleshooting section
4. Contact Vercel support: https://vercel.com/help
5. Contact Supabase support: https://supabase.com/support

## Additional Resources

- Vercel Docs: https://vercel.com/docs
- Supabase Docs: https://supabase.com/docs
- PostgreSQL Docs: https://www.postgresql.org/docs/
- Express.js Docs: https://expressjs.com/
