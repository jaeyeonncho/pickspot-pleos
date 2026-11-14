export function invitationLink(origin,code) {
  if(!/^[A-F0-9]{12}$/.test(code))throw new Error('INVALID_CODE');
  const url=new URL(origin);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('INVALID_ORIGIN');
  return url.origin+'/#join='+code;
}

export function invitationCode(hash) {
  if(!hash)return null;
  const match=/^#join=([A-Fa-f0-9]{12})$/.exec(hash);
  if(!match)throw new Error('INVALID_INVITATION_LINK');
  return match[1].toUpperCase();
}
