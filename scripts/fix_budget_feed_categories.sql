-- increment_budget: thêm feed_like / feed_comment vào khuôn mẫu reset ngày.
--
-- LỖI (phát hiện 27/08): khối reset nửa đêm dựng lại daily_budget bằng
-- jsonb_build_object chỉ liệt kê 6 hạng mục cũ (like, comment, friend_request,
-- join_group, post, scan). Hai hạng mục của newsfeed — feed_like, feed_comment —
-- BỊ XOÁ sạch mỗi đêm. Sau đó dòng
--     v_cat := COALESCE(v_budget->p_action_type, jsonb_build_object('used',0,'max',10))
-- tạo lại hạng mục vắng mặt với max = 10.
-- Hệ quả thật: nick tự cắt ở 10 like và 10 comment mỗi ngày, trong khi cấu hình
-- là 50 — mà không log gì, vì với hệ thống thì đó là "hết hạn mức" hợp lệ.
--
-- SỬA: đưa hai hạng mục feed vào khuôn mẫu reset, và lấy trần từ niche_profiles
-- (daily_likes / daily_comments) — đúng nơi user chỉnh trong UI, để không phải
-- chôn con số ở hai chỗ.
CREATE OR REPLACE FUNCTION public.increment_budget(p_account_id uuid, p_action_type text, p_count integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_budget JSONB; v_cat JSONB; v_used INT; v_max INT; v_reset TIMESTAMPTZ; v_today TIMESTAMPTZ;
  v_niche_likes INT; v_niche_comments INT; v_default_max INT;
BEGIN
  SELECT daily_budget INTO v_budget FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF v_budget IS NULL OR v_budget = '{}'::jsonb THEN v_budget := '{}'::jsonb; END IF;

  -- Trần cấu hình của nick (nơi user chỉnh) — dùng làm mặc định cho hạng mục feed
  SELECT daily_likes, daily_comments INTO v_niche_likes, v_niche_comments
    FROM niche_profiles WHERE account_id = p_account_id LIMIT 1;

  v_reset := (v_budget->>'reset_at')::timestamptz;
  v_today := date_trunc('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_reset IS NULL OR v_reset < v_today THEN
    v_budget := jsonb_build_object('reset_at', v_today::text,
      'like', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'like'->>'max')::int, 80)),
      'comment', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'comment'->>'max')::int, 25)),
      'friend_request', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'friend_request'->>'max')::int, 15)),
      'join_group', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'join_group'->>'max')::int, 3)),
      'post', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'post'->>'max')::int, 5)),
      'scan', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'scan'->>'max')::int, 10)),
      -- Hai hạng mục newsfeed: giữ trần cũ nếu còn, không thì lấy cấu hình nick
      'feed_like', jsonb_build_object('used', 0,
        'max', COALESCE((v_budget->'feed_like'->>'max')::int, v_niche_likes, 50)),
      'feed_comment', jsonb_build_object('used', 0,
        'max', COALESCE((v_budget->'feed_comment'->>'max')::int, v_niche_comments, 25)));
  END IF;

  -- Hạng mục chưa có trong budget: lấy trần từ cấu hình nick thay vì rơi về 10
  v_default_max := CASE p_action_type
    WHEN 'feed_like' THEN COALESCE(v_niche_likes, 50)
    WHEN 'feed_comment' THEN COALESCE(v_niche_comments, 25)
    ELSE 10 END;
  v_cat := COALESCE(v_budget->p_action_type, jsonb_build_object('used', 0, 'max', v_default_max));
  v_used := COALESCE((v_cat->>'used')::int, 0);
  v_max := COALESCE((v_cat->>'max')::int, v_default_max);
  IF v_used + p_count > v_max THEN
    RETURN jsonb_build_object('allowed', false, 'used', v_used, 'max', v_max, 'action', p_action_type);
  END IF;
  v_cat := jsonb_set(v_cat, '{used}', to_jsonb(v_used + p_count));
  v_budget := jsonb_set(v_budget, ARRAY[p_action_type], v_cat);
  UPDATE accounts SET daily_budget = v_budget WHERE id = p_account_id;
  RETURN jsonb_build_object('allowed', true, 'used', v_used + p_count, 'max', v_max, 'action', p_action_type);
END; $function$;
