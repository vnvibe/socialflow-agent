const postPageHandler = require('./post-page')
const postPageGraphHandler = require('./post-page-graph')
const postGroupHandler = require('./post-group')
const postProfileHandler = require('./post-profile')
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

// Campaign role handlers (Sprint 3)
const campaignDiscoverGroupsHandler = require('./campaign-discover-groups')
const campaignScanMembersHandler = require('./campaign-scan-members')
const campaignNurtureHandler = require('./campaign-nurture')
const campaignSendFriendRequestHandler = require('./campaign-send-friend-request')
const campaignInteractProfileHandler = require('./campaign-interact-profile')
const campaignPostHandler = require('./campaign-post')
const campaignGroupMonitorHandler = require('./campaign-group-monitor')
const campaignOpportunityReactHandler = require('./campaign-opportunity-react')
const watchMyPostsHandler = require('./watch-my-posts')
const nurtureFeedHandler = require('./nurture-feed')
const checkGroupMembershipHandler = require('./check-group-membership')

module.exports = {
  post_page: postPageHandler,
  post_page_graph: postPageGraphHandler,
  post_group: postGroupHandler,
  post_profile: postProfileHandler,
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

  // Campaign role handlers
  campaign_discover_groups: campaignDiscoverGroupsHandler,
  campaign_scan_members: campaignScanMembersHandler,
  campaign_nurture: campaignNurtureHandler,
  campaign_send_friend_request: campaignSendFriendRequestHandler,
  campaign_interact_profile: campaignInteractProfileHandler,
  campaign_post: campaignPostHandler,
  campaign_group_monitor: campaignGroupMonitorHandler,
  campaign_opportunity_react: campaignOpportunityReactHandler,
  watch_my_posts: watchMyPostsHandler,
  nurture_feed: nurtureFeedHandler,
  check_group_membership: checkGroupMembershipHandler,
}
