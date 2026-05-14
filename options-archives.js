const ARCHIVES=[
{type:"standard",name:"Государственный архив Ярославской области",region:"Ярославская область",urls:["https://af.yar-archives.ru"]},
{type:"standard",name:"Государственный архив Вологодской области",region:"Вологодская область",urls:["https://gosarchive.gov35.ru"]},
{type:"standard",name:"Государственный архив Саратовской области",region:"Саратовская область",urls:["https://archivesaratov.ru"]},
{type:"standard",name:"Государственный архив Тверской области",region:"Тверская область",urls:["https://archives.tverreg.ru","http://ns2.тверскаяобласть.рф"]},
{type:"standard",name:"Государственный архив Ханты-Мансийского автономного округа",region:"ХМАО — Югра",urls:["https://archivesugra.ru"]},
{type:"standard",name:"Государственный исторический архив Чувашской Республики",region:"Чувашская Республика",urls:["https://giachr.archives21.ru"]},
{type:"standard",name:"Государственный архив Архангельской области",region:"Архангельская область",urls:["https://archives.dvinaland.ru"]},
{type:"standard",name:"Государственный архив Брянской области",region:"Брянская область",urls:["https://el.archive-bryansk.ru"]},
{type:"standard",name:"Государственный архив Ивановской области",region:"Ивановская область",urls:["https://af.ivarh.ru"]},
{type:"standard",name:"Архив Новосибирской области",region:"Новосибирская область",urls:["https://gisarchive.nso.ru"]},
{type:"standard",name:"Государственный архив Омской области",region:"Омская область",urls:["https://lk.iaoo.ru"]},
{type:"standard",name:"Коми-Пермяцкий окружной государственный архив",region:"Пермский край (Коми-Пермяцкий округ)",urls:["https://komi-permarchiv.ru"]},
{type:"standard",name:"Государственный архив Иркутской области",region:"Иркутская область",urls:["https://ais.гаио.рф","https://гаио.рф"]},
{type:"elar",name:"Государственный архив Тюменской области",region:"Тюменская область",urls:["https://gato.72to.ru"]},
{type:"elar",name:"Объединённый государственный архив Челябинской области",region:"Челябинская область",urls:["https://ais.archive74.ru"]},
{type:"elar",name:"Государственный архив Республики Крым",region:"Республика Крым",urls:["http://188.191.26.35:52152"]},
{type:"elar",name:"Государственный архив Ямало-Ненецкого автономного округа",region:"Ямало-Ненецкий автономный округ",urls:["https://ea.yanao.ru"]},
{type:"elar",name:"Государственный архив города Севастополя",region:"Севастополь",urls:["https://aisarhiv.sev.gov.ru"]},
{type:"elar",name:"Государственный архив Курской области",region:"Курская область",urls:["https://kga.rkursk.ru"]},
{type:"elar",name:"Государственный архив Мурманской области",region:"Мурманская область",urls:["https://aisdafmo.gov-murman.ru"]},
{type:"elar",name:"Государственный архив Самарской области",region:"Самарская область",urls:["https://cgaso.regsamarh.ru","https://sogaspi.regsamarh.ru"]},
{type:"elar",name:"Национальный архив Республики Саха",region:"Республика Саха (Якутия)",urls:["https://archive.sakha.gov.ru"]},
{type:"elar",name:"Государственный архив Ставропольского края",region:"Ставропольский край",urls:["https://gisais.stavkomarchiv.ru"]},
{type:"elar",name:"Государственный архив Республики Татарстан",region:"Республика Татарстан",urls:["https://chitzal.eais.tatar.ru"]},
{type:"elar",name:"Государственный архив Пензенской области",region:"Пензенская область",urls:["https://ais.arhivpnz.ru"]},
{type:"vrr",name:"Государственный архив Костромской области",region:"Костромская область",urls:["https://chitalnyj-zal.kosarchive.ru"],note:"Прокрутите документ перед скачиванием."},
{type:"vrr",name:"Государственный архив Приморского края",region:"Приморский край",urls:["https://reading-room.arhiv-25.ru"],note:"Прокрутите документ перед скачиванием."},
{type:"elar",name:"Государственный архив Воронежской области",region:"Воронежская область",urls:["https://gavo.arsvo.ru"]},
{type:"kaisa",name:"Государственный архив Тульской области",region:"Тульская область",urls:["https://gato.tularegion.ru"]},
{type:"kaisa",name:"Архивы Московской области",region:"Московская область",urls:["http://arch.mosreg.ru"]},
{type:"kaisa",name:"Архив Ленинградской области",region:"Ленинградская область",urls:["http://archiveslo.ru"]},
{type:"kaisa",name:"Государственный архив Владимирской области",region:"Владимирская область",urls:["https://vladimir.kaisa.ru"]},
{type:"kaisa",name:"Государственный архив Псковской области",region:"Псковская область",urls:["http://archpskov.kaisa.ru"]},
{type:"kaisa",name:"Государственный архив Томской области",region:"Томская область",urls:["http://archtomsk.tomica.ru"]},
{type:"kaisa",name:"Государственный архив Республики Бурятия",region:"Республика Бурятия",urls:["https://garb.kaisa.ru"]},
{type:"kaisa",name:"Государственный архив Хабаровского края",region:"Хабаровский край",urls:["https://gakhk.khabkrai.ru"]},
{type:"kaisa",name:"Архивы Чувашской Республики",region:"Чувашская Республика",urls:["http://giachr.kaisa.ru"]},
{type:"kaisa",name:"Государственный архив Сахалинской области",region:"Сахалинская область",urls:["https://giaso.ru"]},
{type:"kaisa",name:"Государственный архив Новгородской области",region:"Новгородская область",urls:["http://gano.altsoft.spb.ru"]},
{type:"kaisa",name:"Государственный архив Пермского края",region:"Пермский край",urls:["http://catalog.archive.perm.ru"]},
{type:"kaisa",name:"Государственный архив Красноярского края",region:"Красноярский край",urls:["https://catalog.krasarh.ru"]},
{type:"kaisa",name:"Государственный архив Орловской области",region:"Орловская область",urls:["https://catalog.gaorel.ru"]},
{type:"kaisa",name:"Государственный архив Калужской области",region:"Калужская область",urls:["https://archive.admoblkaluga.ru"]},
{type:"kaisa",name:"Государственный архив Республики Тыва",region:"Республика Тыва",urls:["https://catalog.gosarhivrt.ru"]},
{type:"kaisa",name:"Красноярский городской архив",region:"Красноярск",urls:["https://mkukga.admkrsk.ru"]},
{type:"kaisa",name:"Муниципальные архивы Красноярского края",region:"Красноярский край",urls:["https://krasmun.krasarh.ru"]},
{type:"kaisa",name:"Архивы Алтайского края",region:"Алтайский край",urls:["https://altarchives.ru"]},
{type:"kaisa",name:"Государственный архив Тамбовской области",region:"Тамбовская область",urls:["https://kaisa.tambovarchiv.ru"]},
{type:"kaisa",name:"Государственный архив Ульяновской области",region:"Ульяновская область",urls:["https://ogugauo.ru","https://ulian.kaisa.ru"]},
{type:"yandex",name:"Яндекс Архив",region:"Федеральный сервис",urls:["https://ya.ru/archive","https://yandex.ru/archive"]},
{type:"cgamos",name:"ЦГА Москвы / МНА",region:"Москва",urls:["https://cgamos.ru","https://mos-nha.ru"]},
];

const TYPE_LABELS={standard:"Стандартный",elar:"ЭЛАР",vrr:"VRR",yandex:"Яндекс",cgamos:"ЦГА",kaisa:"КАИСА"};

const list=document.getElementById("archivesList");
const cards=ARCHIVES.map(arch=>{
  arch._s=(arch.name+" "+arch.urls.join(" ")+" "+(arch.region||"")).toLowerCase();
  const card=document.createElement("div");
  card.className="archive-card";
  card.dataset.type=arch.type;
  const urls=arch.urls.map(u=>`<a class="archive-url" href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//,"")}</a>`).join("");
  card.innerHTML=`<div class="archive-card-head"><span class="archive-card-name">${arch.name}</span><span class="type-badge ${arch.type}">${TYPE_LABELS[arch.type]}</span></div><div class="archive-card-urls">${urls}</div>${arch.note?`<div class="archive-note">${arch.note}</div>`:""}`;
  list.appendChild(card);
  return{card,arch};
});
document.getElementById("archivesTotalBadge").textContent=ARCHIVES.length;

function filter(){
  const q=document.getElementById("archivesSearch").value.toLowerCase();
  const type=document.querySelector(".type-pill.active")?.dataset.type||"all";
  let vis=0;
  const cnt={standard:0,elar:0,vrr:0,yandex:0,cgamos:0,kaisa:0};
  let total=0;
  cards.forEach(({card,arch})=>{
    const mq=!q||arch._s.includes(q);
    const mt=type==="all"||arch.type===type;
    card.classList.toggle("hidden",!(mq&&mt));
    if(mq&&mt)vis++;
    if(mq){cnt[arch.type]++;total++;}
  });
  document.getElementById("archivesEmpty").classList.toggle("visible",vis===0);
  document.getElementById("archivesClear").classList.toggle("visible",q.length>0);
  document.getElementById("countAll").textContent="("+total+")";
  document.getElementById("countStandard").textContent="("+cnt.standard+")";
  document.getElementById("countElar").textContent="("+cnt.elar+")";
  document.getElementById("countVrr").textContent="("+cnt.vrr+")";
  document.getElementById("countYandex").textContent="("+cnt.yandex+")";
  document.getElementById("countCgamos").textContent="("+cnt.cgamos+")";
  document.getElementById("countKaisa").textContent="("+cnt.kaisa+")";
}
filter();
document.getElementById("archivesSearch").addEventListener("input",filter);
document.getElementById("archivesClear").addEventListener("click",()=>{document.getElementById("archivesSearch").value="";filter();document.getElementById("archivesSearch").focus();});
document.getElementById("typeFilters").addEventListener("click",e=>{
  const p=e.target.closest(".type-pill");if(!p)return;
  document.querySelectorAll(".type-pill").forEach(x=>x.classList.remove("active"));
  p.classList.add("active");filter();
});
const tog=document.getElementById("archivesToggle"),bod=document.getElementById("archivesBody");
tog.addEventListener("click",()=>{const o=bod.classList.toggle("visible");tog.classList.toggle("open",o);tog.setAttribute("aria-expanded",String(o));});