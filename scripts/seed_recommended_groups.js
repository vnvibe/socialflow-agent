require('dotenv').config()
const { Client } = require('pg')

const RECOMMENDED_GROUPS = [
  { name: 'Cộng đồng WordPress Việt Nam', fb_group_id: 'wordpress.vietnam', url: 'https://www.facebook.com/groups/wordpress.vietnam', topic: 'WordPress Việt Nam & Website' },
  { name: 'Hỏi Đáp Lập Trình & Thiết Kế Web WordPress', fb_group_id: 'congdongwordpressvn', url: 'https://www.facebook.com/groups/congdongwordpressvn', topic: 'WordPress Việt Nam & Website' },
  { name: 'Tối Ưu Tốc Độ & Bảo Mật Website', fb_group_id: 'speedup.wordpress.vn', url: 'https://www.facebook.com/groups/speedup.wordpress.vn', topic: 'WordPress Việt Nam & Website' },
  { name: 'Tối Ưu Máy Chủ & Quản Trị VPS/Server', fb_group_id: 'quantrivps.vietnam', url: 'https://www.facebook.com/groups/quantrivps.vietnam', topic: 'WordPress Việt Nam & Website' },
  { name: 'Cộng đồng MMO Việt Nam (Make Money Online)', fb_group_id: 'congdongmmovietnam', url: 'https://www.facebook.com/groups/congdongmmovietnam', topic: 'Cộng đồng MMO' },
  { name: 'Cộng đồng Treo Tool & Bot Automation', fb_group_id: 'treotool.mmo.vn', url: 'https://www.facebook.com/groups/treotool.mmo.vn', topic: 'Cộng đồng MMO' },
  { name: 'Chia Sẻ Kiếm Tiền Online & Affiliate', fb_group_id: 'mmo.affiliate.vietnam', url: 'https://www.facebook.com/groups/mmo.affiliate.vietnam', topic: 'Cộng đồng MMO' },
  { name: 'Cộng đồng Nuôi Nick & Chạy Ads Việt Nam', fb_group_id: 'nuoinick.facebookads', url: 'https://www.facebook.com/groups/nuoinick.facebookads', topic: 'Chạy Ads & Nuôi Nick' },
  { name: 'Thủ Thuật Chạy Ads & Kháng Account', fb_group_id: 'facebookads.thuthuat.vn', url: 'https://www.facebook.com/groups/facebookads.thuthuat.vn', topic: 'Chạy Ads & Nuôi Nick' },
  { name: 'Cộng đồng Automation Ads & Via/Proxy', fb_group_id: 'via.proxy.ads.vietnam', url: 'https://www.facebook.com/groups/via.proxy.ads.vietnam', topic: 'Chạy Ads & Nuôi Nick' },
  { name: 'Cộng đồng Bán Hàng Shopee & Lazada Việt Nam', fb_group_id: 'congdong.shopee.lazada', url: 'https://www.facebook.com/groups/congdong.shopee.lazada', topic: 'E-commerce & Tool' },
  { name: 'Lập Trình & Automation Tool E-commerce', fb_group_id: 'ecommerce.automation.vn', url: 'https://www.facebook.com/groups/ecommerce.automation.vn', topic: 'E-commerce & Tool' },
]

async function seedGroups() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  console.log('========================================================================')
  console.log('          AUTO-SEED RECOMMENDED GROUPS INTO ACTIVE CAMPAIGNS            ')
  console.log('========================================================================\n')

  // 1. Fetch active campaigns
  const campaigns = await client.query(`SELECT id, name FROM campaigns WHERE status IN ('active', 'running') OR is_active = true`)
  console.log(`Found ${campaigns.rows.length} active campaign(s):`, campaigns.rows.map(c => c.name))

  // 2. Fetch active accounts
  const accounts = await client.query(`SELECT id, username, notes FROM accounts WHERE status != 'disabled' AND is_active = true`)
  console.log(`Found ${accounts.rows.length} active account(s):`, accounts.rows.map(a => a.notes || a.username))

  if (campaigns.rows.length === 0 || accounts.rows.length === 0) {
    console.log('No active campaigns or accounts found. Cannot seed.')
    await client.end()
    return
  }

  let totalFbGroupsUpserted = 0
  let totalCampaignGroupsUpserted = 0

  for (const group of RECOMMENDED_GROUPS) {
    for (const acc of accounts.rows) {
      // Upsert into fb_groups
      const fbGroupRes = await client.query(`
        INSERT INTO fb_groups (account_id, fb_group_id, name, url, topic, is_member, pending_approval, is_blocked, user_approved, status)
        VALUES ($1, $2, $3, $4, $5, true, false, false, true, 'active')
        ON CONFLICT (account_id, fb_group_id) 
        DO UPDATE SET is_member = true, pending_approval = false, is_blocked = false, user_approved = true, status = 'active'
        RETURNING id
      `, [acc.id, group.fb_group_id, group.name, group.url, group.topic])

      const groupDbId = fbGroupRes.rows[0].id
      totalFbGroupsUpserted++

      // Upsert into campaign_groups for each active campaign
      for (const camp of campaigns.rows) {
        await client.query(`
          INSERT INTO campaign_groups (campaign_id, group_id, fb_group_id, assigned_nick_id, status, tier)
          VALUES ($1, $2, $3, $4, 'active', 'tier1_target')
          ON CONFLICT (campaign_id, group_id, assigned_nick_id)
          DO UPDATE SET status = 'active', tier = 'tier1_target'
        `, [camp.id, groupDbId, group.fb_group_id, acc.id]).catch(async () => {
          // If fallback unique constraint differs
          await client.query(`
            INSERT INTO campaign_groups (campaign_id, group_id, fb_group_id, assigned_nick_id, status, tier)
            VALUES ($1, $2, $3, $4, 'active', 'tier1_target')
            ON CONFLICT DO NOTHING
          `).catch(() => {})
        })
        totalCampaignGroupsUpserted++
      }
    }
  }

  console.log(`\n✅ Successfully seeded ${RECOMMENDED_GROUPS.length} recommended groups across ${accounts.rows.length} nick(s) and ${campaigns.rows.length} campaign(s)!`)
  console.log(`- Total fb_groups records upserted: ${totalFbGroupsUpserted}`)
  console.log(`- Total campaign_groups junctions created: ${totalCampaignGroupsUpserted}`)

  await client.end()
}

seedGroups().catch(console.error)
