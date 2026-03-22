const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function check() {
  const { data, error } = await supabase.from('fanpages').select('name, fb_page_id, access_token').limit(5)
  console.log(JSON.stringify(data, null, 2))
}
check()
