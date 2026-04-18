-- ==========================================
-- MJ-Stats Mock Data (Seed)
-- ==========================================

-- 1. ユーザー (5名)
INSERT INTO public.users (id, name) VALUES 
  ('11111111-1111-1111-1111-111111111111', 'こうすけ'),
  ('22222222-2222-2222-2222-222222222222', 'さとし'),
  ('33333333-3333-3333-3333-333333333333', 'りな'),
  ('44444444-4444-4444-4444-444444444444', 'ゆうた'),
  ('55555555-5555-5555-5555-555555555555', 'あや')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 2. リーグ (1つ)
INSERT INTO public.leagues (id, name, owner_id) VALUES 
  ('aaaa0000-aaaa-0000-aaaa-000000000000', 'MJ-Stats Official League', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 3. リーグメンバー (5名全員所属)
INSERT INTO public.league_members (league_id, user_id, role) VALUES 
  ('aaaa0000-aaaa-0000-aaaa-000000000000', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaa0000-aaaa-0000-aaaa-000000000000', '22222222-2222-2222-2222-222222222222', 'member'),
  ('aaaa0000-aaaa-0000-aaaa-000000000000', '33333333-3333-3333-3333-333333333333', 'member'),
  ('aaaa0000-aaaa-0000-aaaa-000000000000', '44444444-4444-4444-4444-444444444444', 'member'),
  ('aaaa0000-aaaa-0000-aaaa-000000000000', '55555555-5555-5555-5555-555555555555', 'member')
ON CONFLICT (league_id, user_id) DO NOTHING;

-- 4. ルール (Mリーグルール等、リーグに紐付け)
INSERT INTO public.rules (id, league_id, name, default_points, return_points, uma_1, uma_2, uma_3, uma_4) VALUES 
  ('99999999-9999-9999-9999-999999999999', 'aaaa0000-aaaa-0000-aaaa-000000000000', 'Mリーグルール', 25000, 30000, 20, 10, -10, -20)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 5. シーズン
INSERT INTO public.seasons (id, league_id, name, start_date, end_date) VALUES 
  ('bbbb0000-bbbb-0000-bbbb-000000000000', 'aaaa0000-aaaa-0000-aaaa-000000000000', '2024 Season 1', '2024-01-01', '2024-12-31')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 6. テスト用の対局記録 (1件だけ履歴を作っておく)
INSERT INTO public.matches (id, season_id, rule_id, recorded_by) VALUES 
  ('cccc0000-cccc-0000-cccc-000000000000', 'bbbb0000-bbbb-0000-bbbb-000000000000', '99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- 7. テスト用の対局結果 (上記の対局に紐づく4人分の結果)
INSERT INTO public.match_results (match_id, user_id, raw_score, final_point, rank) VALUES 
  ('cccc0000-cccc-0000-cccc-000000000000', '11111111-1111-1111-1111-111111111111', 40000, 50.0, 1),
  ('cccc0000-cccc-0000-cccc-000000000000', '22222222-2222-2222-2222-222222222222', 30000, 10.0, 2),
  ('cccc0000-cccc-0000-cccc-000000000000', '55555555-5555-5555-5555-555555555555', 20000, -20.0, 3),
  ('cccc0000-cccc-0000-cccc-000000000000', '33333333-3333-3333-3333-333333333333', 10000, -40.0, 4)
ON CONFLICT (match_id, user_id) DO NOTHING;
