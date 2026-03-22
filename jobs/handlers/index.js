const postPageHandler = require('./post-page')
const postPageGraphHandler = require('./post-page-graph')
const postGroupHandler = require('./post-group')
const postProfileHandler = require('./post-profile')
const processVideoHandler = require('./process-video')
const checkHealthHandler = require('./check-health')
const fetchPagesHandler = require('./fetch-pages')
const fetchGroupsHandler = require('./fetch-groups')
const fetchAllHandler = require('./fetch-all')
const resolveGroupHandler = require('./resolve-group')
const scanGroupKeywordHandler = require('./scan-group-keyword')
const discoverGroupsKeywordHandler = require('./discover-groups-keyword')
const checkEngagementHandler = require('./check-engagement')
const scanGroupFeedHandler = require('./scan-group-feed')
const commentPostHandler = require('./comment-post')
const fetchSourceCookieHandler = require('./fetch-source-cookie')
const joinGroupHandler = require('./join-group')

module.exports = {
  post_page: postPageHandler,
  post_page_graph: postPageGraphHandler,
  post_group: postGroupHandler,
  post_profile: postProfileHandler,
  process_video: processVideoHandler,
  check_health: checkHealthHandler,
  fetch_pages: fetchPagesHandler,
  fetch_groups: fetchGroupsHandler,
  fetch_all: fetchAllHandler,
  resolve_group: resolveGroupHandler,
  scan_group_keyword: scanGroupKeywordHandler,
  discover_groups_keyword: discoverGroupsKeywordHandler,
  check_engagement: checkEngagementHandler,
  scan_group_feed: scanGroupFeedHandler,
  comment_post: commentPostHandler,
  fetch_source_cookie: fetchSourceCookieHandler,
  join_group: joinGroupHandler,
}
