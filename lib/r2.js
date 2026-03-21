const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const fs = require('fs')
const path = require('path')

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
})

const BUCKET = process.env.R2_BUCKET || 'socialflow'

async function uploadToR2(localPath, r2Key) {
  const body = fs.readFileSync(localPath)
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: r2Key,
    Body: body
  }))
  return r2Key
}

async function downloadFromR2(r2Key, localPath) {
  const res = await r2.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: r2Key
  }))

  const dir = path.dirname(localPath)
  fs.mkdirSync(dir, { recursive: true })

  const chunks = []
  for await (const chunk of res.Body) {
    chunks.push(chunk)
  }
  fs.writeFileSync(localPath, Buffer.concat(chunks))
  return localPath
}

async function getSignedUrlForDownload(r2Key, expiresInSeconds = 3600) {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: r2Key
  })
  // Generate a presigned URL that is valid for 1 hour by default
  const signedUrl = await getSignedUrl(r2, command, { expiresIn: expiresInSeconds })
  return signedUrl
}

module.exports = { uploadToR2, downloadFromR2, getSignedUrlForDownload }
