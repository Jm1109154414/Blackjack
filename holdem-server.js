// ═══════════════════════════════════════════════════════════════
//  TEXAS HOLD'EM — Lógica del servidor
// ═══════════════════════════════════════════════════════════════

const WebSocket = require('ws');

// ─── BARAJAS ──────────────────────────────────────────────────
function createDeck() {
  const suits = ['♠','♥','♦','♣'];
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  let d = [];
  for (const s of suits) for (const r of ranks) d.push({suit:s,rank:r});
  for (let i = d.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

// ─── EVALUADOR DE MANOS ────────────────────────────────────────
function rv(rank) {
  const m={2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,'10':10,J:11,Q:12,K:13,A:14};
  return m[rank]||0;
}

function eval5(cards) {
  const rs = cards.map(c=>rv(c.rank)).sort((a,b)=>b-a);
  const ss = cards.map(c=>c.suit);
  const isFlush = ss.every(s=>s===ss[0]);
  // Straight check
  let isStraight=false, straightHigh=0;
  if (new Set(rs).size===5) {
    if (rs[0]-rs[4]===4) { isStraight=true; straightHigh=rs[0]; }
    else if (rs[0]===14&&rs[1]===5&&rs[2]===4&&rs[3]===3&&rs[4]===2) { isStraight=true; straightHigh=5; }
  }
  const cnt={};
  for (const r of rs) cnt[r]=(cnt[r]||0)+1;
  const grp=Object.entries(cnt).map(([r,c])=>({r:+r,c})).sort((a,b)=>b.c-a.c||b.r-a.r);
  const gc=grp.map(g=>g.c), gr=grp.map(g=>g.r);
  if (isFlush&&isStraight) return straightHigh===14 ? {tier:9,val:[9,14],name:'Royal Flush'} : {tier:8,val:[8,straightHigh],name:'Escalera de Color'};
  if (gc[0]===4) return {tier:7,val:[7,gr[0],gr[1]],name:'Póker'};
  if (gc[0]===3&&gc[1]===2) return {tier:6,val:[6,gr[0],gr[1]],name:'Full House'};
  if (isFlush) return {tier:5,val:[5,...rs],name:'Color'};
  if (isStraight) return {tier:4,val:[4,straightHigh],name:'Escalera'};
  if (gc[0]===3) return {tier:3,val:[3,gr[0],gr[1],gr[2]],name:'Trío'};
  if (gc[0]===2&&gc[1]===2) return {tier:2,val:[2,gr[0],gr[1],gr[2]],name:'Doble Par'};
  if (gc[0]===2) return {tier:1,val:[1,gr[0],gr[1],gr[2],gr[3]],name:'Par'};
  return {tier:0,val:[0,...rs],name:'Carta Alta'};
}

function compareEval(a,b) {
  for (let i=0;i<Math.max(a.val.length,b.val.length);i++) {
    const av=a.val[i]||0, bv=b.val[i]||0;
    if (av>bv) return 1; if (av<bv) return -1;
  }
  return 0;
}

function bestHand(holeCards, community) {
  const all = [...holeCards, ...community];
  const n = all.length;
  if (n < 5) return null;
  let best = null;
  // C(n,5) combinations
  for (let a=0;a<n;a++) for (let b=a+1;b<n;b++) for (let c=b+1;c<n;c++)
    for (let d=c+1;d<n;d++) for (let e=d+1;e<n;e++) {
      const ev = eval5([all[a],all[b],all[c],all[d],all[e]]);
      if (!best || compareEval(ev,best)>0) best=ev;
    }
  return best;
}

// ─── ESTADO ───────────────────────────────────────────────────
function createHoldemState() {
  return {
    phase: 'lobby',          // lobby|preflop|flop|turn|river|showdown
    players: {},             // id → player obj
    order: [],               // seat order
    dealerIdx: -1,
    deck: [],
    community: [],           // 0–5 community cards
    pot: 0,
    sidePots: [],
    currentBet: 0,           // amount to call this street
    lastRaise: 0,
    minRaise: 0,
    actingOrder: [],         // ids who still need to act
    actingIdx: 0,
    street: '',              // preflop|flop|turn|river
    pendingRebuy: null,
    handCount: 0,
  };
}

let hState = createHoldemState();

function mkPlayer(id,name,stack,ws) {
  return { id,name,stack,ws,
    holeCards:[], streetBet:0, totalBet:0,
    status:'waiting',        // waiting|active|folded|allin|out
    handEval:null, handName:'',
  };
}

// ─── UTILIDADES ────────────────────────────────────────────────
function hBroadcast(msg) {
  const data=JSON.stringify(msg);
  for (const id in hState.players) {
    const ws=hState.players[id].ws;
    if (ws&&ws.readyState===WebSocket.OPEN) ws.send(data);
  }
}
function hToPlayer(id,msg) {
  const ws=hState.players[id]?.ws;
  if (ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function hChat(text,system=true) { hBroadcast({type:'chat',text,system}); }

function publicHState() {
  const players={};
  for (const id in hState.players) {
    const p=hState.players[id];
    players[id]={
      id,name:p.name,stack:p.stack,status:p.status,
      streetBet:p.streetBet, totalBet:p.totalBet,
      // Ocultar cartas ajenas: se envían como backs {suit:'?'} durante el juego.
      // El personal-send en hSendState() las reemplaza con las reales para su dueño.
      holeCards: (() => {
        if (hState.phase === 'showdown') {
          // Solo contendientes muestran sus cartas en showdown
          return (p.status === 'active' || p.status === 'allin') ? p.holeCards : [];
        }
        if (p.status === 'folded' || p.status === 'out' || p.holeCards.length === 0) return [];
        // Jugador activo durante la mano: mandar backs
        return p.holeCards.map(() => ({ suit: '?', rank: '?' }));
      })(),
      handEval: hState.phase==='showdown' ? p.handEval : null,
      handName: hState.phase==='showdown' ? p.handName : '',
    };
  }
  return {
    phase: hState.phase,
    players,
    order: hState.order,
    community: hState.community,
    pot: hState.pot,
    currentBet: hState.currentBet,
    minRaise: hState.minRaise,
    dealerIdx: hState.dealerIdx,
    currentActor: hState.actingOrder[hState.actingIdx]||null,
    handCount: hState.handCount,
    pendingRebuy: hState.pendingRebuy ? {
      playerId: hState.pendingRebuy.playerId,
      playerName: hState.players[hState.pendingRebuy.playerId]?.name,
      amount: hState.pendingRebuy.amount,
    } : null,
  };
}

function hSendState() {
  // Send state to everyone; for hole cards, send personal version
  const base = publicHState();
  for (const id in hState.players) {
    const ws = hState.players[id].ws;
    if (!ws||ws.readyState!==WebSocket.OPEN) continue;
    const p = hState.players[id];
    const personal = JSON.parse(JSON.stringify(base));
    // Revelar las cartas propias solo durante fases activas (no en showdown,
    // que ya vienen correctas desde publicHState).
    if (hState.phase !== 'showdown' && p.status !== 'out' && p.holeCards.length > 0) {
      personal.players[id].holeCards = p.holeCards;
    }
    ws.send(JSON.stringify({type:'state',state:personal}));
  }
}

// ─── FLUJO DE JUEGO ───────────────────────────────────────────
function activePlayers() {
  return hState.order.filter(id => {
    const p=hState.players[id];
    return p && (p.status==='active'||p.status==='allin');
  });
}
function foldedOrOut(id) {
  const p=hState.players[id];
  return !p||p.status==='folded'||p.status==='out';
}

function startHand() {
  hState.handCount++;
  hState.deck = createDeck();
  hState.community = [];
  hState.pot = 0;
  hState.currentBet = 0;
  hState.lastRaise = 0;

  // Rotate dealer
  const seated = hState.order.filter(id=>hState.players[id]&&hState.players[id].status!=='out');
  if (seated.length<2) return;
  hState.dealerIdx = (hState.dealerIdx+1)%seated.length;

  // Reset players
  for (const id of hState.order) {
    const p=hState.players[id];
    if (!p) continue;
    p.holeCards=[]; p.streetBet=0; p.totalBet=0; p.handEval=null; p.handName='';
    if (p.status==='waiting'||p.status==='folded'||p.status==='allin') p.status='active';
    if (p.stack<=0) p.status='out';
  }
  const active = hState.order.filter(id=>hState.players[id]?.status==='active');
  if (active.length<2) {
    hChat('No hay suficientes jugadores con fichas para continuar.');
    hState.phase='lobby'; hSendState(); return;
  }

  // Deal hole cards
  for (const id of active) for (let i=0;i<2;i++) hState.players[id].holeCards.push(hState.deck.pop());

  // Post blinds
  const SB_AMOUNT=25, BB_AMOUNT=50;
  const sbId = active[hState.dealerIdx%active.length];
  const bbId = active[(hState.dealerIdx+1)%active.length];
  const utg  = active[(hState.dealerIdx+2)%active.length] || sbId;

  function postBlind(id,amount) {
    const p=hState.players[id];
    const actual=Math.min(amount,p.stack);
    p.stack-=actual; p.streetBet=actual; p.totalBet=actual;
    hState.pot+=actual;
    if (p.stack===0) p.status='allin';
    return actual;
  }
  const sbAmt = postBlind(sbId,SB_AMOUNT);
  const bbAmt = postBlind(bbId,BB_AMOUNT);
  hState.currentBet = BB_AMOUNT;
  hState.lastRaise = BB_AMOUNT;
  hState.minRaise = BB_AMOUNT*2;

  hChat(`Mano #${hState.handCount} — Dealer: ${hState.players[sbId]?.name??''} SB·BB: ${hState.players[bbId]?.name??''}`);

  // Preflop acting order: UTG first, BB last (gets option)
  // Build order: start from UTG, go around, BB is last
  const preflopOrder=[];
  const startI = active.indexOf(utg);
  for (let i=0;i<active.length;i++) {
    const id=active[(startI+i)%active.length];
    if (hState.players[id]?.status==='active') preflopOrder.push(id);
  }
  // Move BB to end (for option)
  const bbIdx=preflopOrder.indexOf(bbId);
  if (bbIdx>=0) { preflopOrder.splice(bbIdx,1); preflopOrder.push(bbId); }

  hState.actingOrder=preflopOrder;
  hState.actingIdx=0;
  hState.phase='preflop';
  hState.street='preflop';
  hSendState();
  hChat(`Preflop — ciegas: SB $${sbAmt} / BB $${bbAmt}`);
  notifyTurn();
}

function notifyTurn() {
  const id=hState.actingOrder[hState.actingIdx];
  if (!id) return;
  const p=hState.players[id];
  if (!p) { advanceActor(); return; }
  const callAmt=Math.max(0,hState.currentBet-p.streetBet);
  hBroadcast({type:'turn',actorId:id,actorName:p.name,callAmount:callAmt,pot:hState.pot});
}

function advanceActor() {
  hState.actingIdx++;
  if (hState.actingIdx>=hState.actingOrder.length) {
    // Street over
    nextStreet();
    return;
  }
  const id=hState.actingOrder[hState.actingIdx];
  const p=hState.players[id];
  if (!p||p.status!=='active') { advanceActor(); return; }
  notifyTurn();
  hSendState();
}

function nextStreet() {
  // Check if only 1 active player left
  const act=hState.order.filter(id=>hState.players[id]?.status==='active');
  if (act.length<=1) { finalizeShowdown(); return; }

  // Reset street bets
  for (const id of hState.order) { if(hState.players[id]) hState.players[id].streetBet=0; }
  hState.currentBet=0; hState.lastRaise=0; hState.minRaise=50;

  // Build post-flop acting order: SB first (or first active left of dealer)
  const seated=hState.order.filter(id=>hState.players[id]&&!foldedOrOut(id)&&hState.players[id].status!=='out');
  const dealerPos=hState.dealerIdx%seated.length;
  const postOrder=[];
  for (let i=1;i<=seated.length;i++) {
    const id=seated[(dealerPos+i)%seated.length];
    if (hState.players[id]?.status==='active') postOrder.push(id);
  }

  if (hState.street==='preflop') {
    // Flop
    hState.deck.pop(); // burn
    for (let i=0;i<3;i++) hState.community.push(hState.deck.pop());
    hState.street='flop'; hState.phase='flop';
    hChat(`🃏 FLOP: ${hState.community.map(c=>c.rank+c.suit).join(' ')}`);
  } else if (hState.street==='flop') {
    hState.deck.pop();
    hState.community.push(hState.deck.pop());
    hState.street='turn'; hState.phase='turn';
    hChat(`🃏 TURN: ${hState.community[3].rank+hState.community[3].suit}`);
  } else if (hState.street==='turn') {
    hState.deck.pop();
    hState.community.push(hState.deck.pop());
    hState.street='river'; hState.phase='river';
    hChat(`🃏 RIVER: ${hState.community[4].rank+hState.community[4].suit}`);
  } else {
    // river → showdown
    finalizeShowdown(); return;
  }

  // All remaining active players go all-in automatically if only allins left
  const activeOnly=hState.order.filter(id=>hState.players[id]?.status==='active');
  if (activeOnly.length===0) { finalizeShowdown(); return; }

  if (postOrder.length===0) { nextStreet(); return; }
  hState.actingOrder=postOrder;
  hState.actingIdx=0;
  hSendState();
  notifyTurn();
}

function finalizeShowdown() {
  hState.phase='showdown';
  // Evaluate hands
  const contenders=hState.order.filter(id=>{
    const p=hState.players[id];
    return p&&(p.status==='active'||p.status==='allin')&&p.holeCards.length===2;
  });
  for (const id of contenders) {
    const p=hState.players[id];
    const bh=bestHand(p.holeCards,hState.community);
    p.handEval=bh; p.handName=bh?bh.name:'';
  }
  // Sort best hand
  contenders.sort((a,b)=>{
    const pa=hState.players[a],pb=hState.players[b];
    if (!pa.handEval) return 1; if (!pb.handEval) return -1;
    return compareEval(pb.handEval,pa.handEval);
  });
  // Simple pot distribution (no side pots for simplicity)
  const winners=[];
  if (contenders.length>0) {
    const best=hState.players[contenders[0]].handEval;
    const tied=contenders.filter(id=>{
      const e=hState.players[id].handEval;
      return e && compareEval(e,best)===0;
    });
    const share=Math.floor(hState.pot/tied.length);
    for (const id of tied) {
      hState.players[id].stack+=share;
      winners.push({id,name:hState.players[id].name,win:share,hand:hState.players[id].handName});
    }
    const leftover=hState.pot-share*tied.length;
    if (leftover>0&&tied[0]) hState.players[tied[0]].stack+=leftover;
    for (const w of winners) hChat(`🏆 ${w.name} gana $${w.win} con ${w.hand}!`);
  }
  hSendState();
  hBroadcast({type:'showdown_result',winners});

  // Fold players with 0 stack
  for (const id of hState.order) {
    const p=hState.players[id];
    if (p&&p.stack<=0) p.status='out';
  }

  // Schedule next hand
  setTimeout(()=>{
    hState.pot=0;
    const playable=hState.order.filter(id=>hState.players[id]&&hState.players[id].stack>0);
    if (playable.length>=2) {
      for (const id of hState.order) { if(hState.players[id]&&hState.players[id].status!=='out') hState.players[id].status='active'; }
      startHand();
    } else {
      hState.phase='lobby';
      hChat('No hay suficientes jugadores. Esperando...');
      hSendState();
    }
  },8000);
}

// ─── ACCIONES DE JUGADOR ──────────────────────────────────────
function handleAction(playerId, msg) {
  const p=hState.players[playerId];
  if (!p) return;
  const curActor=hState.actingOrder[hState.actingIdx];
  if (curActor!==playerId) return;
  if (p.status!=='active') return;

  const type=msg.type;
  if (type==='fold') {
    p.status='folded';
    hChat(`${p.name} se fue (fold)`);
    // Check if only 1 active player remains
    const stillActive=hState.order.filter(id=>hState.players[id]?.status==='active');
    if (stillActive.length<=1) {
      // Last active wins
      const winner=stillActive[0];
      if (winner&&hState.players[winner]) {
        hState.players[winner].stack+=hState.pot;
        hChat(`${hState.players[winner].name} gana $${hState.pot} (todos se fueron)`);
        hBroadcast({type:'showdown_result',winners:[{id:winner,name:hState.players[winner].name,win:hState.pot,hand:''}]});
        hState.pot=0;
        setTimeout(()=>{
          const playable=hState.order.filter(id=>hState.players[id]&&hState.players[id].stack>0);
          if (playable.length>=2) {
            for (const id of hState.order) { if(hState.players[id]&&hState.players[id].status!=='out') hState.players[id].status='active'; }
            startHand();
          } else { hState.phase='lobby'; hSendState(); }
        },4000);
        hSendState(); return;
      }
    }
    advanceActor(); hSendState(); return;
  }

  const toCall=Math.max(0,hState.currentBet-p.streetBet);

  if (type==='check') {
    if (toCall>0) { hToPlayer(playerId,{type:'error',text:`Debes igualar $${toCall} o retirarte`}); return; }
    hChat(`${p.name} pasa (check)`);
    advanceActor(); hSendState(); return;
  }

  if (type==='call') {
    const actual=Math.min(toCall,p.stack);
    p.stack-=actual; p.streetBet+=actual; p.totalBet+=actual; hState.pot+=actual;
    if (p.stack===0) { p.status='allin'; hChat(`${p.name} va ALL-IN ($${p.totalBet} total)`); }
    else hChat(`${p.name} iguala ($${actual})`);
    advanceActor(); hSendState(); return;
  }

  if (type==='raise'||type==='allin') {
    // amount = fichas ADICIONALES a poner (para all-in es todo el stack).
    // Para raise normal, msg.amount = nivel TOTAL al que quiere subir (raise-to).
    let extra;
    if (type === 'allin') {
      extra = p.stack;
    } else {
      const targetTotal = parseInt(msg.amount) || 0; // raise-to total
      // Validar: el target debe ser >= minRaise, excepto si el jugador va all-in
      if (targetTotal < hState.minRaise) {
        const maxCanBet = p.stack + p.streetBet;
        if (maxCanBet >= hState.minRaise) {
          // Tiene fichas para el raise mínimo pero no lo alcanzó
          hToPlayer(playerId, { type:'error', text:`Raise mínimo: $${hState.minRaise}` });
          return;
        }
        // Menos que minRaise pero es todo su stack — all-in válido
      }
      extra = Math.min(targetTotal - p.streetBet, p.stack);
      if (extra <= 0) {
        hToPlayer(playerId, { type:'error', text:`Raise mínimo: $${hState.minRaise}` });
        return;
      }
    }

    const actual = Math.min(extra, p.stack);
    p.stack -= actual; p.streetBet += actual; p.totalBet += actual; hState.pot += actual;
    const raiseSize = p.streetBet - hState.currentBet;
    if (raiseSize > 0) {
      hState.lastRaise  = raiseSize;
      hState.currentBet = p.streetBet;
      hState.minRaise   = hState.currentBet + hState.lastRaise;
    }
    if (p.stack === 0) { p.status = 'allin'; hChat(`${p.name} ALL-IN ($${p.totalBet} total)`); }
    else hChat(`${p.name} sube a $${p.streetBet}`);

    // Re-apertura completa: TODOS los activos excepto el que subió deben actuar de nuevo.
    // Se reconstruye desde hState.order para incluir a quienes ya habían actuado antes.
    const raiserSeatIdx = hState.order.indexOf(playerId);
    const newActing = [];
    for (let i = 1; i <= hState.order.length; i++) {
      const sid = hState.order[(raiserSeatIdx + i) % hState.order.length];
      if (sid !== playerId && hState.players[sid]?.status === 'active') newActing.push(sid);
    }
    hState.actingOrder = newActing;
    hState.actingIdx   = 0;
    hSendState();
    if (hState.actingOrder.length > 0) notifyTurn();
    else nextStreet();
    return;
  }
}

// ─── RECOMPRA ─────────────────────────────────────────────────
function hStartRebuy(playerId,amount) {
  if (hState.pendingRebuy) { hToPlayer(playerId,{type:'error',text:'Ya hay una votación activa'}); return; }
  if (amount<100||amount>10000) { hToPlayer(playerId,{type:'error',text:'Monto no válido (100-10000)'}); return; }
  const others=Object.keys(hState.players).filter(id=>id!==playerId);
  if (others.length===0) {
    hState.players[playerId].stack+=amount;
    hToPlayer(playerId,{type:'rebuy_complete',amount});
    hChat(`${hState.players[playerId].name} compró $${amount} en fichas`);
    hSendState(); return;
  }
  hState.pendingRebuy={playerId,amount,votes:{},voters:[...others]};
  hChat(`🗳️ ${hState.players[playerId].name} solicita $${amount} de recompra. Vota (30s).`);
  for (const id of others) hToPlayer(id,{type:'rebuy_vote_request',playerName:hState.players[playerId]?.name,amount});
  setTimeout(()=>{ if(hState.pendingRebuy?.playerId===playerId) hResolveRebuy(); },30000);
  hSendState();
}
function hResolveRebuy() {
  if (!hState.pendingRebuy) return;
  const {playerId,amount,votes,voters}=hState.pendingRebuy;
  const yes=Object.values(votes).filter(v=>v).length;
  const no=Object.values(votes).filter(v=>!v).length;
  const approved=Object.keys(votes).length>0&&yes>no;
  const p=hState.players[playerId];
  if (approved&&p) {
    p.stack+=amount; if(p.status==='out') p.status='active';
    hChat(`✅ Recompra aprobada: ${p.name} +$${amount}`);
    hToPlayer(playerId,{type:'rebuy_complete',amount});
  } else if (p) {
    hChat(`❌ Recompra rechazada para ${p.name}`);
    hToPlayer(playerId,{type:'rebuy_denied'});
  }
  for (const id of voters) hToPlayer(id,{type:'rebuy_vote_closed',approved});
  hState.pendingRebuy=null; hSendState();
}

// ─── EXPORTAR SETUP ───────────────────────────────────────────
function setupHoldemWss(wss_holdem) {
  wss_holdem.on('connection',(ws)=>{
    let myId=null;
    ws.on('message',(raw)=>{
      let msg; try{msg=JSON.parse(raw);}catch{return;}

      if (msg.type==='join') {
        if (Object.keys(hState.players).length>=8) { ws.send(JSON.stringify({type:'error',text:'Mesa llena (máx 8)'})); return; }
        const name=String(msg.name||'Jugador').slice(0,16).trim()||'Jugador';
        const stack=Math.min(10000,Math.max(100,parseInt(msg.stack)||1000));
        myId=`h${Date.now().toString(36)}${Math.random().toString(36).slice(2,4)}`;
        hState.players[myId]=mkPlayer(myId,name,stack,ws);
        if (!hState.order.includes(myId)) hState.order.push(myId);
        if (hState.phase==='lobby') hState.phase='waiting';
        ws.send(JSON.stringify({type:'joined',id:myId}));
        hSendState();
        hChat(`${name} se unió con $${stack} 🃏`);
        return;
      }

      if (!myId||!hState.players[myId]) return;
      const player=hState.players[myId];

      if (msg.type==='start_hand') {
        if (hState.phase!=='waiting'&&hState.phase!=='lobby') return;
        const ready=hState.order.filter(id=>hState.players[id]&&hState.players[id].stack>0);
        if (ready.length<2) { hToPlayer(myId,{type:'error',text:'Se necesitan al menos 2 jugadores'}); return; }
        for (const id of hState.order) { const p=hState.players[id]; if(p&&p.stack>0) p.status='active'; }
        startHand(); return;
      }

      if (['fold','check','call','raise','allin'].includes(msg.type)) {
        if (!['preflop','flop','turn','river'].includes(hState.phase)) return;
        handleAction(myId,msg); return;
      }

      if (msg.type==='rebuy_request') {
        if (hState.phase!=='waiting'&&hState.phase!=='lobby'&&hState.phase!=='showdown') {
          hToPlayer(myId,{type:'error',text:'Solo entre manos'}); return;
        }
        hStartRebuy(myId,parseInt(msg.amount)||0); return;
      }
      if (msg.type==='rebuy_vote') {
        if (!hState.pendingRebuy||!hState.pendingRebuy.voters.includes(myId)) return;
        if (hState.pendingRebuy.votes[myId]!==undefined) return;
        hState.pendingRebuy.votes[myId]=msg.approve;
        hChat(`${player.name} ${msg.approve?'aprobó':'rechazó'} la recompra`);
        if (Object.keys(hState.pendingRebuy.votes).length===hState.pendingRebuy.voters.length) hResolveRebuy();
        else hSendState();
        return;
      }

      if (msg.type==='chat') {
        const t=String(msg.text||'').slice(0,120).trim();
        if(t) hBroadcast({type:'chat',text:`${player.name}: ${t}`,system:false});
        return;
      }
    });

    ws.on('close',()=>{
      if (myId&&hState.players[myId]) {
        const name=hState.players[myId].name;
        // If playing, treat as fold
        if (['preflop','flop','turn','river'].includes(hState.phase)) {
          hState.players[myId].status='folded';
          if (hState.actingOrder[hState.actingIdx]===myId) advanceActor();
        }
        hState.players[myId].status='out';
        hChat(`${name} dejó la mesa`);
        const playable=hState.order.filter(id=>hState.players[id]&&hState.players[id].stack>0);
        if (playable.length<2 && ['preflop','flop','turn','river'].includes(hState.phase)) {
          finalizeShowdown();
        }
        hSendState();
      }
    });
  });
}

module.exports = { setupHoldemWss };