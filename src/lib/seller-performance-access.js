'use strict';

const PRIVILEGED_ROLES=new Set(['admin','accounting','purchase','manager','supervisor']);
const OWN_ONLY_ROLES=new Set(['seller','seller_buyer']);

function resolveSellerScope({role='',requestedSeller='',ownSeller='',normalize=value=>String(value||'').trim()}={}){
  const normalizedRole=String(role||'').trim();
  const requested=normalize(requestedSeller);
  if(PRIVILEGED_ROLES.has(normalizedRole))return {ok:true,sellerAccountNumber:requested,scope:'authorized-sellers'};
  if(!OWN_ONLY_ROLES.has(normalizedRole))return {ok:false,status:403,code:'SELLER_PERFORMANCE_FORBIDDEN',error:'دسترسی عملکرد فروشنده برای این نقش مجاز نیست'};
  const own=normalize(ownSeller);
  if(!own)return {ok:false,status:403,code:'SELLER_MAPPING_REQUIRED',error:'اتصال جاری کارکنان فروشنده برای مشاهده عملکرد کامل نیست'};
  if(requested&&requested!==own)return {ok:false,status:403,code:'SELLER_SCOPE_FORBIDDEN',error:'فروشنده فقط مجاز به مشاهده عملکرد خود است'};
  return {ok:true,sellerAccountNumber:own,scope:'own-seller-only'};
}

module.exports={PRIVILEGED_ROLES,OWN_ONLY_ROLES,resolveSellerScope};
