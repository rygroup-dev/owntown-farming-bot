const io = require('socket.io-client');
const fs = require('fs');
const https = require('https');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { config, persistEnv } = require('./config');
const { Telegram } = require('./telegram');
const path = require('path');

// ============ CONFIG ============
const TOKEN_PATH = config.tokenPath;
const GAME_HOST = config.gameHost;
let WALLET_ADDR = config.walletAddress;
const WALLET_FILE = config.walletFile;
const LOG = config.logPath;
let MY_PLAYER_ID = config.playerId;
try { fs.writeFileSync(LOG, ''); } catch {}

const LOG_RING = [];
const LOG_RING_MAX = 200;
function log(m) {
  const l = new Date().toISOString().slice(11,19) + ' | ' + m;
  try { fs.appendFileSync(LOG, l + '\n'); } catch {}
  process.stdout.write(l + '\n');
  LOG_RING.push(l);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}

// ============ TELEGRAM ============
const tg = new Telegram({
  token: config.telegramToken,
  chatId: config.telegramChatId,
  logger: log,
  onChatIdLearned: (id) => persistEnv('TELEGRAM_CHAT_ID', id),
});
function notify(m) { tg.send(m); }
function notifySys(m) { if (!config.notifyProfitOnly) tg.send(m); }

// ============ ERROR TRACKING ============
function reportError({ code, context, category }) {
  if (category === 'reconnect') { stats.reconnects++; }
  else { stats.errors++; stats.consecutiveErrors++; }
  log(`⚠️ Error: ${code} — ${context || ''}`);
}

// ============ AUTOPILOT STATE ============
let paused = false;
let stopped = false;
let currentActivity = 'idle';
let lastActivity = Date.now();
let activeSocket = null;
let lastCycleStart = Date.now();
let retryTimer = null;
function touchActivity() { lastActivity = Date.now(); }
function scheduleStart(ms) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; startBot(); }, ms);
}

log('=== OWNTOWN SMART FARMER v25.0 ===');
log('AUTO ORCHESTRATOR: Mining+Fishing+Combat+PvP+Quest+Candy+Market+Bank+Crafting');

// ============ CONSTANTS ============
const WALK_SPEED = 0.4;
const MAX_WALK_STEPS = 5000;
let DAILY_EARN_CAP = 0;
let CARRY_CAP = 44;
const MARKET_INTERVAL = 3500;
const LOW_DURABILITY = 30;
const FISHING_TIMEOUT = 120000;
let REST_TIMEOUT = 20000;
let AUTH_TIMEOUT = 20000;
let RECONNECT_BACKOFF_MS = 30000;
const UNDERCUT_PCT = 0.08;
const LOW_STAMINA = 30;
const FATIGUE_THRESHOLD = 0.80;
const LOW_HP = 50;
const HEAL_HP = 80;

// ============ PRICE FLOORS ============
const PRICE_FLOOR = {
  fish_sun_carp: 1.5, fish_moon_koi: 0.2, fish_void_angler: 0.3,
  fish_abyssal_lantern: 0.3, fish_golden_koi: 0.3, fish_silver_darter: 0.1,
  mat_resonance_core: 3, mat_raw_resonite: 0.1, mat_circuit_scrap: 0.1,
  mat_iron_shard: 0.05, mat_carbon_fiber: 0.5,
  gear_resonite_edge: 0.2, gear_fault_greaves: 0.2, gear_volt_anklets: 0.1,
};
const QUICKSELL = {
  mat_raw_resonite: 6, mat_circuit_scrap: 3, mat_iron_shard: 2,
  mat_carbon_fiber: 2, mat_resonance_core: 50,
  fish_silver_darter: 4, fish_sun_carp: 3, fish_moon_koi: 10,
  fish_void_angler: 15, fish_abyssal_lantern: 20, fish_golden_koi: 15,
};

// ============ ITEM CATEGORIES ============
const KEEP = new Set(['tool_pulse_pick','cos_coastal_tee','cos_palm_sneakers','kit_repair','med_patch','food_ember_skewer','food_volt_noodles','pet_demon_salamander','pet_golden_whale','pet_sea_dragon','permit_redline','gear_driftwood_baton']);
const MARKETPLACE_ONLY = new Set(['fish_sun_carp','fish_moon_koi','fish_void_angler','fish_abyssal_lantern','fish_golden_koi','fish_silver_darter','mat_resonance_core','gear_resonite_edge','gear_fault_greaves','gear_volt_anklets']);
const SAFE_QUICKSELL = new Set(['mat_raw_resonite','mat_circuit_scrap','mat_iron_shard','mat_carbon_fiber']);
const FOOD_ITEMS = new Set(['food_ember_skewer','food_volt_noodles','med_patch']);

const GEAR_RECIPES = {
  'craft_repair_kit': { needs: { mat_iron_shard: 2, mat_carbon_fiber: 1 }, fee: 5 },
  'craft_tide_helm': { needs: { mat_iron_shard: 5, mat_circuit_scrap: 3 }, fee: 50 },
  'craft_reef_plate': { needs: { mat_iron_shard: 8, mat_carbon_fiber: 4 }, fee: 80 },
  'craft_dune_boots': { needs: { mat_iron_shard: 3, mat_carbon_fiber: 2 }, fee: 30 },
};

// ============ DYNAMIC WORLD STATE ============
let liveMonsters = [];
let livePlayers = [];
let serverPlayerCount = 0;

const MINING_NODES = [
  { id: 'node_dw_1', pos: {x:75,z:-95} },  { id: 'node_dw_2', pos: {x:95,z:-110} },
  { id: 'node_dw_3', pos: {x:120,z:-90} }, { id: 'node_dw_4', pos: {x:140,z:-120} },
  { id: 'node_dw_5', pos: {x:110,z:-145} },{ id: 'node_dw_6', pos: {x:80,z:-155} },
  { id: 'node_dw_7', pos: {x:150,z:-150} },{ id: 'node_dw_8', pos: {x:135,z:-165} },
];

const ZONE_TARGETS = {
  deepworks:{x:75,z:-95}, pond:{x:-148.5,z:0}, redline_a:{x:-100,z:-120},
  residential:{x:-75,z:0}, spawn_plaza:{x:0,z:0}, clinic:{x:-60,z:-30},
  food_row:{x:20,z:55}, market:{x:25,z:-15}, garage:{x:45,z:-30},
  arena:{x:194,z:-185}, civic_green:{x:10,z:20}, skyvault:{x:50,z:60},
};
const WAYPOINTS_BASE = { fishing:[{x:0,z:0},{x:-80,z:0},{x:-148.5,z:0}] };
const EXPECTED_ZONE = { mining:'deepworks', fishing:'pond', combat:'redline_a', pvp:'arena' };
const ACTIONS = { mining:{count:15,interval:3500}, fishing:{count:5,interval:25000}, combat:{count:5,interval:3000}, pvp:{count:3,interval:5000} };

// ============ STATE ============
let stats = {
  mined:0,fished:0,fought:0,kills:0,xp:0,xpForNext:0,items:0,
  soldQuick:0,soldMarket:0,earnedQuick:0,earnedMarket:0,
  listed:0,canceled:0,crafted:0,repaired:0,errors:0,reconnects:0,
  consecutiveErrors:0,startTime:Date.now(),cycles:0,
  wrongZone:0,fishingTimeouts:0,fatigueDrops:0,restCount:0,
  currentNodeIdx:0,currentMonsterIdx:0,foodEaten:0,
  bossFights:0,bossClaims:0,worldBossActive:false,
  pvpQueued:0,pvpFights:0,pvpWins:0,pvpEarnings:0,
  propertyEarnings:0,bankBalance:0,
  itemsBought:0,itemsFlipped:0,flipProfit:0,
  clinicHeals:0,totalRevenue:0,totalItemsSold:0,
  avgPrices:{},priceSamples:{},holdCount:0,holdValue:0,
  questsCompleted:0,candyClaimed:0,notifications:0,
};
let balance=0,level=1,stamina=100,hp=100,dailyEarned=0,maxHp=100;
let lockedBalance=0,withdrawableBalance=0,prevBalance=null;
let inventory=[],inventoryReady=false,connected=false;
let pos={x:0,z:0},zone='unknown',zoneName='unknown',mapId='main',fishingActive=false;
let myActiveListings=[],marketPrices={},marketHistory=[],fatigueMultiplier=1.0;
let worldBossState=null,bankInfo=null,pvpState=null,economyLedger=[];
let chipBalance=0,candyBalance=0,questState=null,playerStats={},equipmentBonuses={},equipment={};
let tradeLog=[],pendingSales=[],lastCreditAt=0,hourlyProfit={};

// ============ REST API ============
function apiRequest(method,p,body,token,timeoutMs=REST_TIMEOUT){return new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):null;const headers={'Content-Type':'application/json'};if(token)headers['Authorization']='Bearer '+token;if(data)headers['Content-Length']=Buffer.byteLength(data);const req=https.request({hostname:GAME_HOST,path:p,method,headers,timeout:timeoutMs},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(d)})}catch{resolve({status:res.statusCode,data:d})}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));if(data)req.write(data);req.end();})}
async function apiGet(p,token,t){return apiRequest('GET',p,null,token,t)}
async function apiPost(p,body,token,t){return apiRequest('POST',p,body,token,t)}

// ============ AUTH ============
function loadSecretKey(){let b58=config.walletPrivateKey;if(!b58&&WALLET_FILE){try{b58=JSON.parse(fs.readFileSync(WALLET_FILE)).private_key}catch{}}if(!b58)throw new Error('No wallet — set WALLET_PRIVATE_KEY in .env');const sk=bs58.decode(b58);if(sk.length===32)return nacl.sign.keyPair.fromSeed(sk).secretKey;if(sk.length!==64)throw new Error('Bad key length '+sk.length);return sk;}

async function authenticate(){
  const secretKey=loadSecretKey();
  if(!WALLET_ADDR){WALLET_ADDR=bs58.encode(secretKey.slice(32));log(`🔑 Wallet: ${WALLET_ADDR}`);}
  const ch=await apiPost('/api/auth/challenge',{wallet:WALLET_ADDR},undefined,AUTH_TIMEOUT);
  if(ch.status!==200||!ch.data||typeof ch.data!=='object')throw new Error(`Challenge failed (${ch.status})`);
  const nonce=ch.data.nonce||ch.data.challenge;
  if(!nonce)throw new Error('No nonce');
  const message=ch.data.message||('owntown_auth:'+nonce);
  const sig=nacl.sign.detached(Buffer.from(message),secretKey);
  const r=await apiPost('/api/auth/verify',{wallet:WALLET_ADDR,nonce,signature:bs58.encode(sig)},undefined,AUTH_TIMEOUT);
  if(!r.data.token)throw new Error('Auth failed: '+JSON.stringify(r.data));
  try{fs.writeFileSync(TOKEN_PATH,r.data.token)}catch{}
  log('🔑 Authenticated!');
  return r.data.token;
}
function getToken(){try{return fs.readFileSync(TOKEN_PATH,'utf-8').trim()}catch{return null}}
function isTokenExpired(tok){try{return Date.now()>=JSON.parse(Buffer.from(tok.split('.')[1],'base64')).exp*1000-60000}catch{return true}}
let token=getToken();

// ============ MARKET INTELLIGENCE ============
function scanMarketPrices(listings){const best={},counts={};for(const l of listings){if(l.status!=='active')continue;const ppu=l.price/(l.qty||1);if(!best[l.defId]||ppu<best[l.defId])best[l.defId]=ppu;counts[l.defId]=(counts[l.defId]||0)+1;}marketPrices=best;marketHistory.push({time:Date.now(),prices:{...best},counts:{...counts}});if(marketHistory.length>100)marketHistory.shift();for(const[defId,price]of Object.entries(best)){if(!stats.avgPrices[defId]){stats.avgPrices[defId]=price;stats.priceSamples[defId]=1}else{stats.priceSamples[defId]++;stats.avgPrices[defId]=stats.avgPrices[defId]*0.9+price*0.1;}}}
function getMarketDepth(defId){const l=marketHistory[marketHistory.length-1];return l?(l.counts[defId]||0):0}
function getPriceTrend(defId){if(marketHistory.length<3)return'stable';const r=marketHistory.slice(-3).map(h=>h.prices[defId]).filter(Boolean);if(r.length<2)return'stable';const avg=r.reduce((a,b)=>a+b,0)/r.length;const c=(r[r.length-1]-avg)/avg;return c>0.1?'rising':c<-0.1?'falling':'stable'}
function getSellDecision(defId,qty){
  const floor=PRICE_FLOOR[defId]||0;
  const qsPrice=QUICKSELL[defId]||0;
  const mktPrice=marketPrices[defId];
  const depth=getMarketDepth(defId);
  const trend=getPriceTrend(defId);

  // Valuable items (marketplace-only): always try marketplace, hold if no good price
  if(MARKETPLACE_ONLY.has(defId)){
    if(mktPrice&&mktPrice>=floor){
      const undercut=Math.max(floor,Math.round(mktPrice*(1-UNDERCUT_PCT)*10)/10);
      return{action:'MARKETPLACE',price:undercut,marketBest:mktPrice,depth,trend};
    }
    // No market data or price too low — hold, don't dump
    return{action:'HOLD',reason:`valuable (floor ${floor})`,floor};
  }

  // Cheap bulk mats — only these get quicksold (terminal NPC sell)
  if(SAFE_QUICKSELL.has(defId)){
    // But if market price is way higher than QS, list on marketplace instead
    if(mktPrice&&mktPrice>0.5){
      return{action:'MARKETPLACE',price:Math.max(floor||0.1,Math.round(mktPrice*(1-UNDERCUT_PCT)*10)/10),marketBest:mktPrice,depth,trend};
    }
    return{action:'QUICKSELL',price:qsPrice};
  }

  // Unknown items: if we see a market price, list there; otherwise hold (never QS unknowns)
  if(mktPrice&&mktPrice>0.1){
    return{action:'MARKETPLACE',price:Math.max(0.1,Math.round(mktPrice*(1-UNDERCUT_PCT)*10)/10),marketBest:mktPrice,depth,trend};
  }
  if(floor>0)return{action:'HOLD',reason:'no market data, has value',floor};
  return{action:'QUICKSELL',price:qsPrice||1};
}

// ============ PROFIT TRACKING ============
function bucketEarn(a){if(!a||a<=0)return;const k=Math.floor(Date.now()/3600000);hourlyProfit[k]=(hourlyProfit[k]||0)+a;const keys=Object.keys(hourlyProfit).map(Number).sort((a,b)=>a-b);while(keys.length>48)delete hourlyProfit[keys.shift()]}
function getHourly(n=12){const cur=Math.floor(Date.now()/3600000),out=[];for(let i=n-1;i>=0;i--){const k=cur-i;out.push({h:String(new Date(k*3600000).getHours()).padStart(2,'0'),v:Math.round(hourlyProfit[k]||0)})}return out}
function recordSale(defId,qty,method,price){const total=price*qty;stats.totalRevenue+=total;stats.totalItemsSold+=qty;if(method==='quickSell'){stats.soldQuick+=qty;stats.earnedQuick+=total}else{stats.soldMarket+=qty;stats.earnedMarket+=total}bucketEarn(total);tradeLog.push({t:Date.now(),defId,qty,method,price,total});if(tradeLog.length>120)tradeLog.shift();pendingSales.push({t:Date.now(),defId,qty,method,price,total});lastCreditAt=Date.now();log(`💰 ${method==='quickSell'?'QS':'MKT'} ${defId} x${qty} @${price} = ${total}`)}
function cleanName(id){return String(id).replace(/^(mat_|fish_|wpn_|tool_|cos_|food_|med_|kit_|pet_|permit_|gear_|mount_|veh_)/,'').replace(/_/g,' ')}
function getProfitSummary(){const h=(Date.now()-stats.startTime)/3600000;const t=stats.earnedQuick+stats.earnedMarket+stats.pvpEarnings+stats.propertyEarnings;return{totalEarned:t,rate:h>0?Math.round(t/h):0,itemsSold:stats.totalItemsSold,hours:h.toFixed(1)}}

// ============ SMART ORCHESTRATOR ============
function decideNextAction(){
  if(hp<LOW_HP&&zone!=='clinic')return'heal';
  if(inventory.length>=CARRY_CAP-4)return'sell';
  if(stamina<LOW_STAMINA)return'eat';
  // Quest-driven: if quest needs sell and we have actually sellable (not just holdable) items
  if(questState&&questState.activeId==='sell_your_first_haul'){
    const sellable=inventory.filter(i=>!KEEP.has(i.defId)&&i.qty>0&&(SAFE_QUICKSELL.has(i.defId)||marketPrices[i.defId]));
    if(sellable.length>0)return'sell';
  }
  const order=['sell','mining','fishing','combat','mining','fishing','mining','combat'];
  return order[stats.cycles%order.length];
}

// ============ QUEST AUTO-PROGRESS ============
function tryProgressQuest(sock){
  if(!questState||!questState.activeId)return;
  const q=questState.activeId;
  // "sell_your_first_haul" — walk to market, then sell triggers completion
  if(q==='sell_your_first_haul'&&questState.step===0){
    log('📜 Quest: walking to market to progress quest');
    walkDirect(sock,ZONE_TARGETS.market,()=>{
      sock.emit('quest:action',{type:'check'});
    });
  }
  // Generic: always emit check after actions
  sock.emit('quest:action',{type:'check'});
}
function getAliveMonster(){if(liveMonsters.length>0){const alive=liveMonsters.filter(m=>m.alive);if(alive.length>0)return alive[stats.currentMonsterIdx%alive.length]}return{id:'mon_1',pos:{x:-100,z:-120}}}

// ============ CRAFTING / FOOD / HEAL ============
function tryCraft(sock){for(const[id,r]of Object.entries(GEAR_RECIPES)){let ok=true;for(const[m,q]of Object.entries(r.needs))if(!inventory.find(i=>i.defId===m&&i.qty>=q)){ok=false;break}if(ok&&balance>=r.fee){sock.emit('inventory:craft',{recipeId:id});stats.crafted++;log(`🔨 Craft ${id}`);return true}}return false}
function tryEatFood(sock){const f=inventory.find(i=>i.defId==='med_patch')||inventory.find(i=>i.defId==='food_ember_skewer')||inventory.find(i=>i.defId==='food_volt_noodles')||inventory.find(i=>FOOD_ITEMS.has(i.defId));if(f){sock.emit('inventory:use',{instanceId:f.instanceId});stats.foodEaten++;return true}return false}
function tryClinicHeal(sock){if(zone==='clinic'&&hp<HEAL_HP&&balance>=10){sock.emit('shop:clinicHeal');stats.clinicHeals++;return true}return false}

// ============ BANK ============
async function checkBank(tok){try{const r=await apiGet('/api/bank/status',tok);if(r.status===200&&r.data){bankInfo=r.data;stats.bankBalance=r.data.withdrawable||0;log(`🏦 Bank: ${r.data.withdrawable} withdrawable, chain:${r.data.onChainBalance||'?'}`)}}catch{}}

// ============ PvP ============
function pvpQueue(sock){if(level>=5&&stamina>=30){sock.emit('pvp:queue');stats.pvpQueued++;return true}return false}

// ============ FLIP / POWERUP ============
let lastFlipTime=0,buySpentToday=0,buyDay=new Date().toISOString().slice(0,10);
function rolloverBuyDay(){const d=new Date().toISOString().slice(0,10);if(d!==buyDay){buyDay=d;buySpentToday=0}}
function canSpend(a){rolloverBuyDay();return(balance-config.balanceReserve)>=a&&(buySpentToday+a)<=config.dailyBuyCap}
function recordSpend(a){rolloverBuyDay();buySpentToday+=a}
function checkFlipOpportunities(sock,listings){if(!config.flipEnabled||!MY_PLAYER_ID||Date.now()-lastFlipTime<config.flipCooldownSec*1000)return false;let best=null,bp=0;for(const l of listings){if(l.sellerPlayerId===MY_PLAYER_ID||l.status!=='active'||!l.qty)continue;const mp=marketPrices[l.defId];if(!mp||mp<0.05)continue;const cost=l.price+Math.max(0.1,l.price*0.05);const rev=mp*l.qty*0.92;const p=rev-cost;if(l.price/l.qty<mp*config.flipUnderprice&&l.price<=config.flipMaxCost&&p>=config.flipMinProfit&&canSpend(cost)&&p>bp){bp=p;best={l,p,cost}}}if(best){sock.emit('marketplace:buy',{listingId:best.l.id});stats.itemsBought++;stats.itemsFlipped++;recordSpend(best.cost);lastFlipTime=Date.now();return true}return false}
let lastPowerupTime=0,pendingEquip=null;
const POWERUP_WANTS={kit_repair:{maxPrice:60,maxQty:5},med_patch:{maxPrice:70,maxQty:6},food_ember_skewer:{maxPrice:35,maxQty:10}};
function checkPowerupBuys(sock,listings){if(!config.powerupEnabled||!MY_PLAYER_ID||Date.now()-lastPowerupTime<15000)return false;for(const[defId,want]of Object.entries(POWERUP_WANTS)){const have=inventory.filter(i=>i.defId===defId).reduce((s,i)=>s+i.qty,0);if(have>=want.maxQty)continue;let best=null;for(const l of listings){if(l.sellerPlayerId===MY_PLAYER_ID||l.status!=='active'||l.defId!==defId)continue;if(l.price/(l.qty||1)<=want.maxPrice&&canSpend(l.price)&&(!best||l.price<best.price))best=l}if(best){sock.emit('marketplace:buy',{listingId:best.id});stats.itemsBought++;recordSpend(best.price);lastPowerupTime=Date.now();return true}}return false}

// ============ WALKING ============
function walkStaged(sock,wps,idx,cb){if(!connected)return;if(idx>=wps.length){cb();return}const wp=wps[idx];let step=0;const baseMs=250+Math.floor(Math.random()*100);const iv=setInterval(()=>{if(!connected){clearInterval(iv);return}const dx=wp.x-pos.x,dz=wp.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);if(dist<2||step>=MAX_WALK_STEPS){clearInterval(iv);sock.emit('player:input',{pos:{x:wp.x,y:0,z:wp.z},rotY:0,anim:'idle'});setTimeout(()=>walkStaged(sock,wps,idx+1,cb),800+Math.floor(Math.random()*400));return}const jitter=(Math.random()-0.5)*0.06;const speed=WALK_SPEED+jitter;pos.x+=(dx/dist)*speed;pos.z+=(dz/dist)*speed;sock.emit('player:input',{pos:{x:pos.x,y:0,z:pos.z},rotY:Math.atan2(dx,dz),anim:'walk'});step++},baseMs)}
function walkDirect(sock,target,cb){if(!connected){cb();return}let step=0;const baseMs=250+Math.floor(Math.random()*100);const iv=setInterval(()=>{if(!connected){clearInterval(iv);return}const dx=target.x-pos.x,dz=target.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);if(dist<5||step>=MAX_WALK_STEPS){clearInterval(iv);sock.emit('player:input',{pos:{x:target.x,y:0,z:target.z},rotY:0,anim:'idle'});setTimeout(cb,800+Math.floor(Math.random()*400));return}const jitter=(Math.random()-0.5)*0.06;const speed=WALK_SPEED+jitter;pos.x+=(dx/dist)*speed;pos.z+=(dz/dist)*speed;sock.emit('player:input',{pos:{x:pos.x,y:0,z:pos.z},rotY:Math.atan2(dx,dz),anim:'walk'});step++},baseMs)}

// ============ SELL ============
function doSellPhase(sock,cb){
  const sellable=inventory.filter(i=>!KEEP.has(i.defId)&&i.qty>0&&i.status!=='locked');
  if(!sellable.length){log('💰 Nothing to sell');cb();return}
  tryCraft(sock);log(`💰 SELL ${sellable.length} sellable / ${inventory.length} total`);const old=[...myActiveListings];function cancelNext(i){if(i>=old.length){freshSell(sock,cb);return}sock.emit('marketplace:cancel',{listingId:old[i].id});stats.canceled++;setTimeout(()=>cancelNext(i+1),1500)}if(old.length>0)cancelNext(0);else freshSell(sock,cb)}
function freshSell(sock,cb){const toM=[],toQ=[],toH=[];for(const item of inventory){if(KEEP.has(item.defId)||item.qty<1||item.status==='locked')continue;const d=getSellDecision(item.defId,item.qty);if(d.action==='HOLD'){toH.push({defId:item.defId,qty:item.qty,reason:d.reason});stats.holdCount++}else if(d.action==='MARKETPLACE')toM.push({instanceId:item.instanceId,defId:item.defId,qty:item.qty,price:d.price,marketBest:d.marketBest});else toQ.push({instanceId:item.instanceId,defId:item.defId,qty:item.qty})}log(`📊 MKT:${toM.length} QS:${toQ.length} HOLD:${toH.length}`);for(const m of toM)log(`  📋 ${m.defId} x${m.qty} → MKT @${m.price} (best:${m.marketBest})`);for(const h of toH)log(`  🛡️ ${h.defId} x${h.qty} → HOLD (${h.reason})`);for(const q of toQ)log(`  💸 ${q.defId} x${q.qty} → QS`);function listNext(i){if(i>=toM.length||!connected){if(toQ.length)quickSellSafe(sock,toQ.filter(x=>SAFE_QUICKSELL.has(x.defId)));setTimeout(cb,3000);return}const m=toM[i];sock.emit('marketplace:list',{instanceId:m.instanceId,qty:m.qty,price:m.price});log(`📋 ${m.defId} x${m.qty} @${m.price}`);setTimeout(()=>listNext(i+1),MARKET_INTERVAL)}if(toM.length>0)listNext(0);else if(toQ.length){quickSellSafe(sock,toQ.filter(x=>SAFE_QUICKSELL.has(x.defId)));setTimeout(cb,3000)}else cb()}
function quickSellSafe(sock,items){for(const it of items){if(!SAFE_QUICKSELL.has(it.defId)||!it.instanceId)continue;sock.emit('marketplace:quickSell',{instanceId:it.instanceId,qty:it.qty||1})}}

// ============ ACTIONS ============
function doActions(sock,type){if(!connected)return;currentActivity=type;const cfg=ACTIONS[type];let count=0,lastCatch=Date.now();const mon=getAliveMonster();const node=MINING_NODES[stats.currentNodeIdx%MINING_NODES.length];const jitteredInterval=cfg.interval+Math.floor(Math.random()*800)-200;log(`▶ ${type} (max ${cfg.count})`);const iv=setInterval(()=>{if(!connected){clearInterval(iv);return}if(stats.consecutiveErrors>=5){clearInterval(iv);stats.consecutiveErrors=0;setTimeout(()=>runNextCycle(sock),2000);return}if(hp<LOW_HP)tryEatFood(sock);if(type==='fishing'&&fishingActive&&Date.now()-lastCatch>FISHING_TIMEOUT){clearInterval(iv);fishingActive=false;stats.fishingTimeouts++;setTimeout(()=>runNextCycle(sock),2000);return}if(count>=cfg.count){clearInterval(iv);if(type==='mining')stats.currentNodeIdx=(stats.currentNodeIdx+1)%MINING_NODES.length;if(type==='combat')stats.currentMonsterIdx=(stats.currentMonsterIdx+1)%Math.max(1,liveMonsters.length);setTimeout(()=>runNextCycle(sock),2000+Math.floor(Math.random()*2000));return}if(type==='mining'){sock.emit('mining:start',{nodeId:node.id});count++}else if(type==='fishing'){if(!fishingActive){sock.emit('fishing:cast',{spotId:'fish_dock'});lastCatch=Date.now();count++}}else if(type==='combat'){sock.emit('combat:attack',{monsterId:mon.id});count++}else if(type==='pvp'){sock.emit('pvp:attack');stats.pvpFights++;count++}},jitteredInterval)}

// ============ CYCLE ============
function runNextCycle(sock){
  if(!connected)return;lastCycleStart=Date.now();
  if(paused){setTimeout(()=>runNextCycle(sock),5000);return}
  if(stats.consecutiveErrors>=10){sock.disconnect();scheduleStart(5000);return}
  if(stamina<LOW_STAMINA)tryEatFood(sock);
  if(worldBossState&&worldBossState.phase==='active'&&level>=(worldBossState.minLevel||10)&&!stats.worldBossActive){stats.worldBossActive=true;sock.emit('worldboss:enter');notify(`👹 <b>World Boss!</b> Entering`)}
  stats.cycles++;stats.consecutiveErrors=0;
  const type=decideNextAction();
  log(`\n=== Cycle ${stats.cycles}: ${type.toUpperCase()} ===`);
  if(type==='heal'){walkDirect(sock,ZONE_TARGETS.clinic,()=>{tryClinicHeal(sock);setTimeout(()=>runNextCycle(sock),2000)});return}
  if(type==='eat'){tryEatFood(sock);setTimeout(()=>runNextCycle(sock),2000);return}
  if(type==='sell'){
    sock.emit('economy:ledger');
    // Walk to market first (needed for quest progress + better for selling)
    walkDirect(sock,ZONE_TARGETS.market,()=>{
      sock.emit('quest:action',{type:'check'});
      doSellPhase(sock,()=>{
        // After selling, check quest progress
        sock.emit('quest:action',{type:'check'});
        setTimeout(()=>runNextCycle(sock),1500);
      });
    });
    return;
  }
  let wps;
  if(type==='mining')wps=[{x:0,z:0},MINING_NODES[stats.currentNodeIdx%MINING_NODES.length].pos];
  else if(type==='combat')wps=[{x:0,z:0},{x:-80,z:0},getAliveMonster().pos];
  else if(type==='pvp')wps=[{x:0,z:0},ZONE_TARGETS.arena];
  else wps=WAYPOINTS_BASE[type]||[{x:0,z:0}];
  walkStaged(sock,wps,0,()=>{
    if(!connected)return;
    const exp=EXPECTED_ZONE[type];
    if(exp&&zone!==exp&&zone!=='unknown'){stats.wrongZone++;reportError({code:'WRONG_ZONE',context:`need ${exp}, at ${zone}`});const t=ZONE_TARGETS[exp];if(t){walkDirect(sock,t,()=>{if(zone!==exp){setTimeout(()=>runNextCycle(sock),2000);return}doActions(sock,type)});return}}
    if(type==='pvp'){pvpQueue(sock);doActions(sock,type)}else doActions(sock,type);
  });
}

// ============ MAIN BOT ============
let fundingNotified=false;
async function startBot(){
  if(stopped)return;
  if(retryTimer){clearTimeout(retryTimer);retryTimer=null}
  if(activeSocket){try{activeSocket.removeAllListeners();activeSocket.disconnect()}catch{}activeSocket=null}
  connected=false;inventoryReady=false;
  if(!token||isTokenExpired(token)){
    try{token=await authenticate()}catch(e){
      log('❌ Auth: '+e.message);
      if(/timeout/i.test(e.message))reportError({code:'AUTH_TIMEOUT',context:'auth timeout',category:'reconnect'});
      if(e.message.includes('INSUFFICIENT_OTWN')){if(!fundingNotified){fundingNotified=true;notify(`⛽ <b>Need OTWN</b>\n<code>${WALLET_ADDR}</code>`)}scheduleStart(300000);return}
      fundingNotified=false;scheduleStart(30000);return;
    }
    fundingNotified=false;
  }
  const socket=io('https://'+GAME_HOST,{auth:{token},transports:['polling'],upgrade:false,reconnection:false});

  socket.on('player:correction',(d)=>{if(d.pos){pos.x=d.pos.x;pos.z=d.pos.z}});
  socket.on('player:state',(d)=>{
    if(d.zone)zone=d.zone;if(d.zoneName)zoneName=d.zoneName;if(d.mapId)mapId=d.mapId;
    if(d.lockedBalance!==undefined)lockedBalance=d.lockedBalance;
    if(d.withdrawableBalance!==undefined)withdrawableBalance=d.withdrawableBalance;
    if(d.chipBalance!==undefined)chipBalance=d.chipBalance;
    if(d.candyBalance!==undefined)candyBalance=d.candyBalance;
    if(d.stats){playerStats=d.stats;if(d.stats.carryCapacity)CARRY_CAP=d.stats.carryCapacity}
    if(d.equipmentBonuses)equipmentBonuses=d.equipmentBonuses;
    if(d.equipment)equipment=d.equipment;
    if(d.xpForNextLevel!==undefined)stats.xpForNext=d.xpForNextLevel;
    if(d.gameBalance!==undefined){if(prevBalance!==null&&d.gameBalance<prevBalance){const drop=+(prevBalance-d.gameBalance).toFixed(2);if(drop>=20)notify(`📉 <b>-${drop}</b> · ${d.gameBalance.toFixed(0)} OTWN`)}prevBalance=d.gameBalance;balance=d.gameBalance}
    if(d.level!==undefined){if(level&&d.level>level)notify(`⬆️ <b>Level ${d.level}!</b>`);level=d.level}
    if(d.stamina!==undefined)stamina=d.stamina;
    if(d.health!==undefined)hp=d.health;
    if(d.stats&&d.stats.maxHealth)maxHp=d.stats.maxHealth;
    if(d.dailyEarnedOtwn!==undefined)dailyEarned=d.dailyEarnedOtwn;
    if(d.dailyEarnCap!==undefined&&d.dailyEarnCap>0)DAILY_EARN_CAP=d.dailyEarnCap;
    const pid=d.playerId||d.id;if(pid&&!MY_PLAYER_ID){MY_PLAYER_ID=String(pid);log(`🆔 Player: ${MY_PLAYER_ID}`)}
  });
  socket.on('inventory:update',(d)=>{inventory=(d.items||[]).filter(i=>i.qty>0);if(!inventoryReady){inventoryReady=true;log(`📦 ${inventory.length} stacks`)}const tool=d.items.find(i=>i.defId==='tool_pulse_pick');if(tool&&tool.durability!==null&&tool.durability<LOW_DURABILITY&&tool.instanceId){socket.emit('inventory:repair',{instanceId:tool.instanceId});stats.repaired++}if(pendingEquip){const item=inventory.find(i=>i.defId===pendingEquip);if(item){socket.emit('equipment:set',{instanceId:item.instanceId,slot:'weapon'});pendingEquip=null}}});
  socket.on('marketplace:update',(d)=>{if(d.listings){myActiveListings=d.listings.filter(l=>l.sellerPlayerId===MY_PLAYER_ID&&l.status==='active');scanMarketPrices(d.listings);if(!checkFlipOpportunities(socket,d.listings))checkPowerupBuys(socket,d.listings)}});
  socket.on('mining:result',(d)=>{touchActivity();stats.mined++;stats.xp+=d.xpGained||0;stats.items+=d.qty||0;stats.consecutiveErrors=0;if(d.fatigueMultiplier!==undefined)fatigueMultiplier=d.fatigueMultiplier;log(`⛏ ${d.itemName} x${d.qty} +${d.xpGained}XP`)});
  socket.on('mining:error',(d)=>{reportError({code:d.code,context:'mining'})});
  socket.on('fishing:cast',()=>{fishingActive=true});
  socket.on('fishing:result',(d)=>{touchActivity();fishingActive=false;stats.fished++;stats.xp+=d.xp||d.xpGained||0;stats.consecutiveErrors=0;log(`🎣 ${d.itemName||'fish'} x${d.qty||1} +${d.xp||0}XP`)});
  socket.on('fishing:error',(d)=>{fishingActive=false;reportError({code:d.code,context:'fishing'})});
  socket.on('combat:result',(d)=>{touchActivity();stats.fought++;stats.xp+=d.xpGained||0;stats.consecutiveErrors=0;if(d.playerHp!==undefined)hp=d.playerHp;if(d.killed){stats.kills++;log(`⚔ KILL +${d.xpGained}XP`)}});
  socket.on('combat:error',(d)=>{reportError({code:d.code,context:'combat'})});
  socket.on('combat:drop',(d)=>{stats.items++;log(`⚔ DROP ${d.itemName} x${d.qty}`)});
  socket.on('worldboss:state',(d)=>{worldBossState=d;if(d.phase==='active'&&!stats.worldBossActive){stats.worldBossActive=true;socket.emit('worldboss:enter');notify(`👹 <b>World Boss!</b>`)}if(d.phase==='dead'){socket.emit('worldboss:claim');stats.bossClaims++}});
  socket.on('pvp:state',(d)=>{pvpState=d});
  socket.on('pvp:result',(d)=>{stats.pvpFights++;if(d.won){stats.pvpWins++;const r=d.reward||d.otwn||0;stats.pvpEarnings+=r;bucketEarn(r);log(`⚔️ PvP WIN +${r}`)}});
  socket.on('pvp:leaderboardData',(d)=>{if(d.entries)log(`⚔️ PvP board: ${d.entries.length} entries, #1: ${d.entries[0]?.name||'?'}`)});
  socket.on('quest:state',(d)=>{
    const prev=questState;questState=d;
    const changed=!prev||prev.activeId!==d.activeId||prev.step!==d.step||prev.progress!==d.progress||(prev.completed||[]).length!==(d.completed||[]).length;
    if(changed){
      log(`📜 Quest: ${d.activeId||'none'} step:${d.step||0} progress:${d.progress||0} done:${(d.completed||[]).length}`);
      // Quest completed notification
      if(prev&&prev.activeId&&!d.activeId){
        stats.questsCompleted++;
        notify(`🏆 <b>Quest selesai!</b> ${prev.activeId}\nTotal: ${(d.completed||[]).length} quests`);
      }
      // New quest available — auto-start
      if(prev&&prev.activeId&&d.activeId&&prev.activeId!==d.activeId){
        notify(`📜 <b>Quest baru:</b> ${d.activeId}`);
      }
    }
  });
  socket.on('quest:toast',(d)=>{notifySys(`📜 <b>${d.title}</b>\n${d.message}`)});
  socket.on('candy:error',(d)=>{log(`🍬 ${d.code}: ${d.message||''}`)});
  socket.on('casino:error',(d)=>{log(`🎰 ${d.code}: ${d.message||''}`)});
  socket.on('casino:state',(d)=>{log(`🎰 Casino: ${JSON.stringify(d).slice(0,150)}`)});
  socket.on('casino:result',(d)=>{log(`🎰 Result: ${JSON.stringify(d).slice(0,150)}`)});
  socket.on('global:alert',(d)=>{notify(`🔔 <b>Alert</b>\n${d.message||JSON.stringify(d)}`)});
  let lastSnapLog=0;
  socket.on('world:snapshot',(d)=>{serverPlayerCount=d.playerCount||0;if(d.monsters)liveMonsters=d.monsters;if(d.players)livePlayers=d.players;if(Date.now()-lastSnapLog>60000){lastSnapLog=Date.now();log(`🌍 ${serverPlayerCount} online, ${liveMonsters.filter(m=>m.alive).length} mobs`)}});
  socket.on('property:infoResult',(d)=>{log(`🏠 ${d.properties?.length||0} properties`)});
  socket.on('property:result',(d)=>{if(d.ok&&d.earnings){stats.propertyEarnings+=d.earnings;bucketEarn(d.earnings)}});
  socket.on('shop:result',(d)=>{if(d.ok)log(`🛒 ${d.item||d.action||'ok'}`)});
  socket.on('economy:ledger',(d)=>{if(d.entries)economyLedger=d.entries});
  socket.on('marketplace:result',(d)=>{if(d.ok&&d.credited)recordSale(d.defId||'qs',d.count||d.qty||1,'quickSell',d.credited)});
  socket.on('marketplace:quickSell:result',(d)=>{if(d.credited)recordSale(d.defId||'qs',d.count||d.qty||1,'quickSell',d.credited)});
  ['marketplace:list:result','marketplace:listed'].forEach(e=>socket.on(e,()=>{stats.listed++}));
  socket.on('toast',(d)=>{if(d.kind==='success'){const msg=(d.message||'').toLowerCase();if((msg.includes('sold')||msg.includes('received'))&&Date.now()-lastCreditAt>3500){const m=d.message.match(/(\d[\d,.]*)\s*\$?OTWN/);if(m){const a=parseFloat(m[1].replace(/,/g,''));if(a>0)recordSale('market-sale',1,'marketplace',a)}}}});
  socket.on('inventory:craft',(d)=>{log(`🔨 Crafted`)});
  socket.on('inventory:repair',()=>{log('🔧 Repaired')});
  socket.on('notifications',(d)=>{if(d.items)stats.notifications=d.items.length});

  socket.on('connect',()=>{
    connected=true;touchActivity();if(retryTimer){clearTimeout(retryTimer);retryTimer=null}
    log('Connected!');notifySys(`🟢 <b>Connected</b> — ${GAME_HOST}`);activeSocket=socket;
    let started=false;
    socket.on('player:correction',function onC(d){if(!started&&d.pos){pos.x=d.pos.x;pos.z=d.pos.z;started=true;socket.removeListener('player:correction',onC);log(`Pos:(${pos.x.toFixed(1)},${pos.z.toFixed(1)}) ${zoneName}`);waitInv(socket,()=>{socket.emit('economy:ledger');checkBank(token);socket.emit('property:info',{});socket.emit('candy:claim');runNextCycle(socket)})}});
    setTimeout(()=>{if(!started){started=true;waitInv(socket,()=>runNextCycle(socket))}},3000);
  });
  socket.on('disconnect',(r)=>{log('Disconnected: '+r);connected=false;if(stopped)return;reportError({code:r,context:'disconnect',category:'reconnect'});notifySys(`🔴 Disconnected — reconn ${Math.round(RECONNECT_BACKOFF_MS/1000)}s`);scheduleStart(RECONNECT_BACKOFF_MS)});
  socket.on('connect_error',(err)=>{const msg=(err&&err.message)||'connect_error';log('⚠️ '+msg);if(stopped)return;reportError({code:msg,context:'connect_error',category:'reconnect'});if(/auth|token|unauthorized|forbidden|403|401/i.test(msg))token=null;try{socket.disconnect()}catch{}scheduleStart(5000)});
  function waitInv(s,cb){if(inventoryReady){cb();return}let w=0;const iv=setInterval(()=>{w+=500;if(inventoryReady||w>5000){clearInterval(iv);cb()}},500)}
}

// ============ FORMATTING ============
function fmt(n){const v=Number(n||0);if(v>=1)return v.toLocaleString('en-US',{maximumFractionDigits:2});if(v>0)return v.toFixed(4);return'0'}
function fmtUptime(ms){const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+'d ':'')+(h?h+'h ':'')+m+'m'}
const esc=s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

// ============ REPORTS ============
setInterval(()=>{const p=getProfitSummary();const t=[`${connected?'🟢':'🔴'} <b>v25</b> ${paused?'⏸️':connected?'▶️ '+currentActivity:'⏳'}`,`⏱${fmtUptime(Date.now()-stats.startTime)} 📍${zoneName} Lv${level}`,`💰${fmt(Math.round(balance))} earned:${fmt(p.totalEarned)} ${fmt(p.rate)}/h`,`⛏${fmt(stats.mined)} 🎣${fmt(stats.fished)} ⚔${fmt(stats.kills)}`].join('\n');log('\n'+t.replace(/<[^>]+>/g,'')+'\n');notify(t)},Math.max(1,config.reportIntervalMin)*60000);

let dailyBaseline=null;
function snapDaily(){const p=getProfitSummary();dailyBaseline={t:Date.now(),balance,totalEarned:p.totalEarned,mined:stats.mined,fished:stats.fished,kills:stats.kills}}
function buildDaily(){const p=getProfitSummary();const b=dailyBaseline||{t:stats.startTime,balance,totalEarned:0,mined:0,fished:0,kills:0};const h=Math.max(0.1,(Date.now()-b.t)/3600000);return`📅 <b>DAILY</b> ~${h.toFixed(1)}h\n<pre>Earned +${fmt(Math.round(p.totalEarned-b.totalEarned))}\nBalance ${fmt(Math.round(balance))}\n⛏${fmt(stats.mined-b.mined)} 🎣${fmt(stats.fished-b.fished)} ⚔${fmt(stats.kills-b.kills)}</pre>`}
snapDaily();setInterval(()=>{notify(buildDaily());snapDaily()},24*3600000);

setInterval(()=>{if(!pendingSales.length)return;const count=pendingSales.reduce((s,r)=>s+r.qty,0);const sum=pendingSales.reduce((s,r)=>s+r.total,0);const lines={};for(const r of pendingSales){const k=cleanName(r.defId);if(!lines[k])lines[k]={qty:0,total:0};lines[k].qty+=r.qty;lines[k].total+=r.total}const body=Object.entries(lines).sort((a,b)=>b[1].total-a[1].total).slice(0,10).map(([k,v])=>`${k.padEnd(12).slice(0,12)} x${v.qty} +${fmt(v.total)}`).join('\n');pendingSales=[];notify(`🛒 <b>Sold</b> ${count} · +${fmt(sum)}\n<pre>${body}</pre>`)},120000);

// ============ WATCHDOG ============
const WD_MS=Math.max(2,config.watchdogStuckMin)*60000;
setInterval(()=>{if(paused||stopped)return;const idle=Date.now()-lastActivity;if(connected&&idle>WD_MS){log('🐶 WATCHDOG');touchActivity();if(activeSocket&&activeSocket.connected)try{runNextCycle(activeSocket)}catch{}else scheduleStart(2000)}if(!connected&&idle>WD_MS*2){touchActivity();scheduleStart(2000)}},60000);

// ============ TELEGRAM COMMANDS ============
tg.on('help',()=>notify(['🏭 <b>OWNTOWN v25 — Smart Orchestrator</b>','','📊 /status /balance /daily /income /wallet','🎮 /inventory /market /trades /listings','📜 /quest /candy /boss /world /pvpboard','⚙️ /start /stop /pause /resume /reauth /restart /update','🔧 /health /errors /settings /schedule /log /ping','','<i>⚠️ 1 wallet = 1 sesi</i>'].join('\n')));
tg.on('start',()=>{paused=false;stopped=false;if(connected){notify('▶️ Already farming.');return}notify('🚀 Connecting…');startBot()});
tg.on('stop',()=>{stopped=true;paused=false;if(retryTimer){clearTimeout(retryTimer);retryTimer=null}try{if(activeSocket)activeSocket.disconnect()}catch{}connected=false;notify('⏹️ <b>Stopped</b> — main manual.')});
tg.on('status',()=>{const p=getProfitSummary(),up=fmtUptime(Date.now()-stats.startTime),alive=liveMonsters.filter(m=>m.alive).length;notify([`${connected?'🟢':'🔴'} <b>OWNTOWN v25</b> · ${paused?'⏸️':stopped?'⏹️':connected?'▶️ '+currentActivity:'⏳'}`,`<i>⏱${up} · 📍${zoneName} · Lv${level} (${stats.xp}/${stats.xpForNext||'?'}XP)</i>`,'','💰 <b>Economy</b>',`<pre>Balance  ${fmt(Math.round(balance))} OTWN\nCandy    ${fmt(candyBalance)}\nChip     ${fmt(chipBalance)}\nBank     ${fmt(stats.bankBalance)}\nEarned   ${fmt(p.totalEarned)} · ${fmt(p.rate)}/h</pre>`,'',`🧍 ❤️${hp}/${maxHp} ⚡${stamina} 📦${inventory.length}/${CARRY_CAP}`,`⛏${fmt(stats.mined)} 🎣${fmt(stats.fished)} ⚔${fmt(stats.kills)} 🔨${fmt(stats.crafted)} 👹${fmt(stats.bossClaims)}`,`🌍 ${serverPlayerCount} online · ${alive}/${liveMonsters.length} mobs · boss:${worldBossState?.phase||'?'}`,`📜 Quest: ${questState?.activeId||'none'} (${(questState?.completed||[]).length} done)`,`${stats.errors?'⚠️':'✅'} err:${stats.errors} reconn:${stats.reconnects||0}`].join('\n'))});
tg.on('stats',()=>tg.handlers['status']());
tg.on('balance',()=>notify(`💰 <b>Balance</b>\n<pre>OTWN     ${fmt(Math.round(balance))}\nLocked   ${fmt(lockedBalance)}\nCandy    ${fmt(candyBalance)} 🍬\nChip     ${fmt(chipBalance)} 🎰\nBank     ${fmt(stats.bankBalance)}\nDaily    ${fmt(dailyEarned)} / ${DAILY_EARN_CAP||'∞'}</pre>`));
tg.on('daily',()=>notify(buildDaily()));
tg.on('income',()=>{const p=getProfitSummary();const hrs=getHourly(12).map(h=>`${h.h}:00 ${'█'.repeat(Math.min(10,Math.ceil(h.v/Math.max(1,...getHourly(12).map(x=>x.v))*10)))} +${fmt(h.v)}`).join('\n');notify(`💵 <b>Income</b>\n<pre>Total  ${fmt(p.totalEarned)}\nRate   ${fmt(p.rate)}/h\nQS     +${fmt(stats.earnedQuick)}\nMKT    +${fmt(stats.earnedMarket)}\nPvP    +${fmt(stats.pvpEarnings)}\nSold   ${fmt(p.itemsSold)}</pre>\n<pre>${hrs}</pre>`)});
tg.on('wallet',()=>notify(`🔑 <b>Wallet</b>\n<code>${WALLET_ADDR||'auto'}</code>\n💰${fmt(Math.round(balance))} 🍬${fmt(candyBalance)} 🎰${fmt(chipBalance)}`));
tg.on('quest',()=>{if(!questState){notify('📜 No quest data.');return}notify(`📜 <b>Quest</b>\nActive: <b>${questState.activeId||'none'}</b>\nStep: ${questState.step||0} Progress: ${questState.progress||0}\nDone: ${(questState.completed||[]).join(', ')||'none'}`)});
tg.on('candy',async()=>{try{const h=await apiGet('/api/health');const e=h.data?.economy||{};notify(`🍬 <b>Candy</b>\nBalance: <b>${fmt(candyBalance)}</b>\n<pre>Price    $${e.candyUsd||'?'}\n1 CANDY  ${e.lastCandyOtwn||'?'} OTWN\nStaked   ${fmt(e.candyStaked)} OTWN\nPool     ${fmt(e.candyDailyPool)}/day\nMinted   ${fmt(e.candyMinted)}\nBurned   ${fmt(e.candyBurned)}\nVol 24h  ${fmt(e.candyVolume24h)}</pre>`)}catch(er){notify(`🍬 ${fmt(candyBalance)} (err: ${er.message})`)}});
tg.on('boss',()=>{if(!worldBossState){notify('👹 No data.');return}const next=worldBossState.nextSpawnAt?new Date(worldBossState.nextSpawnAt).toISOString().slice(11,16):'?';notify(`👹 <b>World Boss</b>\nPhase: <b>${worldBossState.phase}</b>\nHP: ${worldBossState.hp||0}/${worldBossState.maxHp||500000}\nNext: ${next} UTC\nMin Lv: ${worldBossState.minLevel||10}\nClaims: ${stats.bossClaims}`)});
tg.on('world',()=>{const zones={};for(const p of livePlayers)zones[p.zone]=(zones[p.zone]||0)+1;const zl=Object.entries(zones).sort((a,b)=>b[1]-a[1]).map(([z,c])=>`${z}:${c}`).join(' ');const alive=liveMonsters.filter(m=>m.alive);const ml=alive.map(m=>`${m.name||m.defId} Lv${m.level} ${m.hp}/${m.maxHp}`).join('\n')||'none';notify(`🌍 <b>World</b>\nPlayers: <b>${serverPlayerCount}</b>\nZones: ${zl||'?'}\nBoss: ${worldBossState?.phase||'?'}\n\n<b>Mobs</b>\n<pre>${ml}</pre>`)});
tg.on('pvpboard',()=>{if(activeSocket)activeSocket.emit('pvp:leaderboard');notify('⚔️ Leaderboard requested — /log')});
tg.on('market',()=>{if(!Object.keys(marketPrices).length){notify('📊 No data.');return}const rows=Object.entries(marketPrices).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>{const t=getPriceTrend(k);return`${cleanName(k).padEnd(14).slice(0,14)} ${String(v).padStart(6)} ${t==='rising'?'📈':t==='falling'?'📉':'➡️'} ${getMarketDepth(k)}ea`}).join('\n');notify(`📊 <b>Market</b>\n<pre>${rows}</pre>`)});
tg.on('trades',()=>{if(!tradeLog.length){notify('🧾 None.');return}const rows=tradeLog.slice(-15).reverse().map(r=>`${new Date(r.t).toLocaleTimeString('id',{hour:'2-digit',minute:'2-digit'})} ${r.method==='quickSell'?'QS':'MK'} ${cleanName(r.defId).slice(0,12)} +${fmt(r.total)}`).join('\n');notify(`🧾 <b>Trades</b>\n<pre>${rows}</pre>`)});
tg.on('listings',()=>{if(!myActiveListings.length){notify('🏷️ None.');return}const r=myActiveListings.map(l=>`${cleanName(l.defId).slice(0,14)} x${l.qty||1} @${fmt(l.price)}`).join('\n');notify(`🏷️ <b>Listings</b>\n<pre>${r}</pre>`)});
tg.on('inventory',()=>{if(!inventory.length){notify('🎒 Empty.');return}const s=[...inventory].sort((a,b)=>((PRICE_FLOOR[b.defId]||QUICKSELL[b.defId]||0)*b.qty)-((PRICE_FLOOR[a.defId]||QUICKSELL[a.defId]||0)*a.qty));const rows=s.slice(0,25).map(i=>{const v=(PRICE_FLOOR[i.defId]||QUICKSELL[i.defId]||0)*i.qty;return`${KEEP.has(i.defId)?'🔒':'  '}${cleanName(i.defId).padEnd(13).slice(0,13)} x${String(i.qty).padStart(3)} ~${fmt(v)}`}).join('\n');const t=inventory.reduce((s,i)=>s+(PRICE_FLOOR[i.defId]||QUICKSELL[i.defId]||0)*i.qty,0);notify(`🎒 <b>Inventory</b> (${inventory.length}/${CARRY_CAP}) ~${fmt(t)}\n<pre>${rows}</pre>`)});
tg.on('health',()=>{const m=process.memoryUsage();notify(`🩺 <b>Health</b>\n<pre>Game     ${connected?'🟢':'🔴'}\nToken    ${token&&!isTokenExpired(token)?'✅':'⚠️'}\nErrors   ${stats.errors} (${stats.consecutiveErrors})\nReconns  ${stats.reconnects||0}\nSchedule ${schedStatus()}\nMemory   ${(m.rss/1048576).toFixed(0)}MB\nUptime   ${fmtUptime(Date.now()-stats.startTime)}\nWorld    ${serverPlayerCount} online\nNode     ${process.version}</pre>`)});
tg.on('errors',()=>{const e=LOG_RING.filter(l=>/ERR|❌|💥|⚠️|fail/i.test(l)).slice(-15);notify(`🧯 <b>Errors</b>\n<pre>${esc(e.join('\n'))||'none 🎉'}</pre>`)});
tg.on('settings',()=>notify(`⚙️ <b>Settings</b>\n<pre>Schedule  ${scheduleActive?config.scheduleRaw:'off'}\nFlip      ${config.flipEnabled?'ON':'OFF'}\nReserve   ${fmt(config.balanceReserve)}\nPowerup   ${config.powerupEnabled?'ON':'OFF'}\nBuy today ${fmt(buySpentToday)}/${fmt(config.dailyBuyCap)}</pre>`));
tg.on('log',(a)=>{const n=Math.min(50,Math.max(1,parseInt(a[0]||'15',10)||15));notify('<pre>'+esc(LOG_RING.slice(-n).join('\n')||'empty')+'</pre>')});
tg.on('logs',(a)=>tg.handlers['log'](a));
tg.on('pause',()=>{paused=true;notify('⏸️ Paused')});
tg.on('resume',()=>{if(!paused){notify('▶️ Running.');return}paused=false;notify('▶️ Resumed');if(activeSocket&&activeSocket.connected)runNextCycle(activeSocket)});
tg.on('reauth',()=>{notify('🔑 Re-auth…');token=null;try{if(activeSocket)activeSocket.disconnect()}catch{}setTimeout(startBot,1500)});
tg.on('ping',()=>notify(`🏓 pong · ${connected?'🟢':'🔴'} · ${fmtUptime(Date.now()-stats.startTime)} · ${serverPlayerCount} online`));
tg.on('schedule',()=>{const l=schedulePhases.map((p,i)=>`${i===schedIdx?'▶️':'  '} ${p.state.toUpperCase()} ${p.hours}h`).join('\n');notify(`🗓️ <b>Schedule</b>\n${scheduleActive?schedStatus():'off'}\n<pre>${l||'none'}</pre>`)});
tg.on('restart',()=>{notify('♻️ Restarting…');setTimeout(()=>process.exit(0),800)});
tg.on('update',()=>{notify('⬇️ Pulling…');const{execFile}=require('child_process');execFile('git',['-C',__dirname,'pull','--ff-only'],(e,o,s)=>{notify('<pre>'+esc(String(o||s||e).slice(0,600))+'</pre>');if(!e){notify('♻️ Restarting…');setTimeout(()=>process.exit(0),1000)}})});

// ============ CRASH ============
process.on('uncaughtException',(err)=>{log('💥 '+((err&&err.stack)||err));notify(`💥 <b>Crash</b>: ${err&&err.message||err}`);setTimeout(()=>process.exit(1),1200)});
process.on('unhandledRejection',(r)=>{log('💥 unhandledRejection: '+((r&&r.stack)||r))});

// ============ SCHEDULE ============
let schedulePhases=[],schedIdx=0,schedPhaseEnd=0;
const scheduleActive=config.scheduleEnabled;
function parseSchedule(raw){return raw.split(',').map(s=>{const[st,h]=s.split(':');return{state:(st||'').trim().toLowerCase()==='off'?'off':'on',hours:parseFloat(h)||1}}).filter(p=>p.hours>0)}
function jitterMs(h){return Math.round(h*3600000*(1+(Math.random()*2-1)*config.scheduleJitterPct/100))}
function schedUntilStr(){return new Date(schedPhaseEnd).toISOString().slice(11,16)}
function applyPhase(ann){const p=schedulePhases[schedIdx];if(!p)return;schedPhaseEnd=Date.now()+jitterMs(p.hours);if(p.state==='on'){if(stopped){stopped=false;startBot()}}else{stopped=true;if(retryTimer){clearTimeout(retryTimer);retryTimer=null}try{if(activeSocket)activeSocket.disconnect()}catch{}connected=false}if(ann)notifySys(`🗓️ <b>${p.state.toUpperCase()}</b> ~${p.hours}h`)}
function schedStatus(){if(!scheduleActive||!schedulePhases.length)return'off';const p=schedulePhases[schedIdx],m=Math.max(0,Math.round((schedPhaseEnd-Date.now())/60000));return`${p.state.toUpperCase()} ~${Math.floor(m/60)}h${m%60}m`}
if(scheduleActive){schedulePhases=parseSchedule(config.scheduleRaw);if(schedulePhases.length)applyPhase(false)}
setInterval(()=>{if(!scheduleActive||!schedulePhases.length)return;if(Date.now()>=schedPhaseEnd){schedIdx=(schedIdx+1)%schedulePhases.length;applyPhase(true)}},30000);

// ============ BOOT ============
log('🚀 v25 Smart Orchestrator starting…');
tg.startPolling();
notifySys('🚀 <b>Owntown v25</b> — Smart Orchestrator\n<i>/help commands · /status dashboard</i>');
startBot();
