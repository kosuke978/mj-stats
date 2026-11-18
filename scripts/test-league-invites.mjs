import { dbAssertions, fixtureID, leagueA, leagueB, ownerA, ownerB } from './test-rule-season-foundation.mjs'

export function testLeagueInvites(sql, coreFingerprint) {
  const api = 'mjstats_api'
  const [authA, authB, inviteA, inviteB, request] = [81, 82, 83, 84, 85].map(fixtureID)
  const eventFingerprint = "SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.league_events e;"
  const inviteFingerprint = "SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.league_invites i;"
  const { check, reject } = dbAssertions(sql, coreFingerprint + eventFingerprint + inviteFingerprint)
  sql(`INSERT INTO auth.users(id,email_confirmed_at) VALUES ('${authA}',now()),('${authB}',now());`, 'supabase_admin')
  sql(`UPDATE public.users SET auth_id='${authA}',profile_completed_at=now() WHERE id='${ownerA}';
    UPDATE public.users SET auth_id='${authB}',profile_completed_at=now() WHERE id='${ownerB}';
    INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status) VALUES
      ('${leagueA}','${ownerB}','registered','member','active'),
      ('${leagueB}','${ownerA}','registered','admin','active');`)
  const scope = (league, actor = ownerA) =>
    `SET LOCAL mjstats.invite_league_id='${league}'; SET LOCAL mjstats.league_actor_id='${actor}'`
  const issue = (id, league, actor = ownerA, hash = "repeat('a',64)", duration = "interval '168 hours'") => `
    INSERT INTO public.league_invites(id,league_id,issued_by,issued_at,expires_at,key_version,credential_hash)
    VALUES ('${id}','${league}','${actor}',now()-interval '10 days',now()-interval '10 days'+${duration},1,${hash})`
  const event = (league, target, payload = "'{}'::jsonb", requestID = request) => `
    INSERT INTO public.league_events(league_id,actor_id,operation,client_request_id,target,version,request_hash,after)
    VALUES ('${league}','${ownerA}','invite.issue','${requestID}','${target}',1,repeat('b',64),${payload})`
  const asAPI = statement => sql(`BEGIN; SET LOCAL ROLE ${api}; ${statement}; COMMIT;`, 'supabase_admin')
  reject('invite requires scope', issue(inviteA, leagueA), '42501', api)
  reject('invite cannot spoof issuer', `${scope(leagueA)}; ${issue(inviteA, leagueA, ownerB)}`, '42501', api)
  reject('member cannot issue', `${scope(leagueA, ownerB)}; ${issue(inviteA, leagueA, ownerB)}`, '42501', api)
  reject('strict credential digest', `${scope(leagueA)}; ${issue(inviteA, leagueA, ownerA, "repeat('G',64)")}`, '23514', api)
  reject('strict seven-day lifetime', `${scope(leagueA)}; ${issue(inviteA, leagueA, ownerA, undefined, "interval '169 hours'")}`, '23514', api)
  reject('event target required in same league', `${scope(leagueA)}; ${event(leagueA, inviteB)}`, '23503', api)
  asAPI(`${scope(leagueA)}; ${issue(inviteA, leagueA)}; ${event(leagueA, inviteA)}`)
  reject('expired unrevoked invite occupies slot', `${scope(leagueA)}; ${issue(inviteB, leagueA)}`, '23505', api)
  reject('credential column cannot be updated', `${scope(leagueA)}; UPDATE public.league_invites SET credential_hash=repeat('b',64)`, '42501', api)
  reject('credential invite cannot be deleted', 'DELETE FROM public.league_invites', '42501', api)
  reject('event prevents invite deletion', `DELETE FROM public.league_invites WHERE id='${inviteA}'`, '23503')
  reject('event cannot reference another league', `${scope(leagueB)}; ${event(leagueB, inviteA, undefined, fixtureID(86))}`, '23503', api)
  asAPI(`${scope(leagueB)}; ${issue(inviteB, leagueB)}`)
  reject('invite event accepts only empty payload', `${scope(leagueB)}; ${event(leagueB, inviteB, "jsonb_build_object('unexpected',true)")}`, '23514', api)
  const other = asAPI(`${scope(leagueB)};
    SELECT count(*)=1 AND bool_and(id='${inviteB}') FROM public.league_invites;
    SELECT NOT EXISTS (SELECT invite_id FROM public.league_events WHERE operation='invite.issue');
    SELECT mjstats_private.invite_request_used_elsewhere('invite.issue','${request}')`).split('\n').slice(-4,-1)
  if (!other.every(value => value === 't') || other.length !== 3) throw new Error('invite and event scope leakage')
  check('invite scope ends with tx', 'NOT EXISTS (SELECT FROM public.league_invites)', api)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    reject('invite private from public roles', 'SELECT * FROM public.league_invites', '42501', role)
    reject('public issuance denied', issue(inviteA, leagueA), '42501', role)
    reject('public revoke denied', 'UPDATE public.league_invites SET revoked_at=now()', '42501', role)
  }
  console.log('PASS Q-25 invitations: expiry/partial uniqueness, same-league event FK and payload, actor/league scope, immutable credential and public access denial')
}
