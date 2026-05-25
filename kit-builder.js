/* ════════════════════════════════════════════════════════════════════
   kit-builder.js — SHARED kit-component builder  [build: KB-2026-05-25-C]
   Loaded by BOTH setup.html and admin.html via <script src="kit-builder.js">.
   Edit once, both pages update. No build step — plain global script.

   Usage:
     KitBuilder.init({
       SB, KEY,                      // supabase creds (required)
       g, esc,                       // helper fns from the host page (required)
       getCats:  function(){...},    // returns category list array
       getSkus:  function(){...},    // returns sku list array (for component dropdowns)
       containerId:  'sf-kit-components',   // where component rows render
       warningId:    'sf-kit-warning',      // naked-component warning div (optional)
       pkgTypeId:    'sf-kit-pkg-type',     // packaging type <select>
       onPromote:    function(idx){...}     // optional: promote-to-SKU handler
     });

   Then: KitBuilder.addRow(data?), KitBuilder.collect(), KitBuilder.reset(),
         KitBuilder.populatePackaging(), KitBuilder.FIELDS

   All internal element IDs (kc-*) are unchanged so existing markup keeps working.
   ════════════════════════════════════════════════════════════════════ */
var KitBuilder = (function(){
  var cfg = null;
  var rows = [];   // active row indices

  // Shared draft-SKU component field definitions (factory-safe "plain" layer).
  var FIELDS = [
    {key:'product_title',  label:'Product name',         type:'text',  ph:'e.g. 100g Shampoo Bar',          plain:true},
    {key:'description',    label:'Description',           type:'textarea', ph:'What it is, key details',      plain:true},
    {key:'size_volume',    label:'Size / volume',         type:'text',  ph:'e.g. 8 g, 30 ml', note:'Marketed label size', plain:true},
    {key:'unit_l',         label:'Unit L (cm)',           type:'number',ph:'e.g. 3', step:'0.01', note:'Physical size of one piece', plain:true},
    {key:'unit_w',         label:'Unit W (cm)',           type:'number',ph:'e.g. 3', step:'0.01',             plain:true},
    {key:'unit_h',         label:'Unit H (cm)',           type:'number',ph:'e.g. 10', step:'0.01',            plain:true},
    {key:'unit_wt_g',      label:'Unit weight (g)',       type:'number',ph:'e.g. 6', step:'0.1', note:'Shipping weight of one piece, for freight', plain:true},
    {key:'units_per_master',label:'Units / master carton',type:'number',ph:'e.g. 100', step:'1', note:'How many ship in one bulk carton', plain:true},
    {key:'unit_cost',      label:'Your price (per unit)', type:'number',ph:'e.g. 0.45', step:'0.0001',        plain:true}
  ];

  function g(id){return cfg.g(id);}
  function esc(s){return cfg.esc(s);}
  function cats(){return (cfg.getCats?cfg.getCats():[])||[];}
  function skus(){return (cfg.getSkus?cfg.getSkus():[])||[];}

  function init(config){
    cfg = config;
    cfg.pkgOptions = cfg.pkgOptions || {primary:[],closure:[],secondary:[]};
    rows = [];
  }
  // Per-row SearchDropdown instances for new-packaging entry: pkgDD[idx]={primary,closure,secondary}
  var pkgDD = {};

  function reset(){
    rows = [];
    pkgDD = {};
    var wrap = g(cfg.containerId);
    if(wrap) wrap.innerHTML='';
  }

  async function populatePackaging(){
    if(!cfg.pkgTypeId) return;
    var sel = g(cfg.pkgTypeId); if(!sel) return;
    var current = sel.value;
    try{
      var r = await fetch(cfg.SB+'/rest/v1/kit_packaging_types?active=eq.true&select=name&order=sort_order,name',{headers:{'apikey':cfg.KEY,'Authorization':'Bearer '+cfg.KEY}});
      var types = r.ok?await r.json():[];
      sel.innerHTML='<option value="">— Select packaging —</option>'+types.map(function(t){return '<option value="'+esc(t.name)+'">'+esc(t.name)+'</option>';}).join('');
      if(current) sel.value=current;
    }catch(e){console.error('[KitBuilder] packaging dropdown:',e);}
  }

  function skuOptions(selectedId){
    var opts='<option value="">— New / factory-described (enter details below) —</option>';
    skus().forEach(function(s){
      if(s.is_kit) return; // a kit can't be a component of itself
      opts+='<option value="'+s.id+'"'+(s.id===selectedId?' selected':'')+'>'+esc(s.model_number||'')+' — '+esc((s.description||'').slice(0,40))+'</option>';
    });
    return opts;
  }

  function catOptions(selectedId){
    var opts='<option value="">— uncategorized —</option>';
    cats().forEach(function(c){
      var label=[c.category,c.sub_category,c.sub_sub_category].filter(Boolean).join(' › ');
      opts+='<option value="'+c.id+'"'+(c.id===selectedId?' selected':'')+'>'+esc(label)+'</option>';
    });
    return opts;
  }

  function plainFieldsHtml(idx,data){
    var fields=cfg.hidePrice?FIELDS.filter(function(f){return f.key!=='unit_cost';}):FIELDS;
    var inner=fields.map(function(f){
      var id='kc-'+f.key+'-'+idx;
      var v=data[f.key]!=null?data[f.key]:'';
      var span=(f.type==='textarea'||f.key==='product_title')?'grid-column:1/-1;':'';
      var input;
      if(f.type==='textarea'){
        input='<textarea id="'+id+'" rows="2" placeholder="'+f.ph+'" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;resize:vertical;">'+esc(String(v))+'</textarea>';
      } else if(f.type==='number'){
        input='<input type="number" id="'+id+'" value="'+(v||'')+'" step="'+(f.step||'0.01')+'" placeholder="'+f.ph+'" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;" />';
      } else {
        input='<input type="text" id="'+id+'" value="'+esc(String(v))+'" placeholder="'+f.ph+'" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;" />';
      }
      return '<div style="'+span+'"><label style="font-size:10px;color:#888;display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.04em;">'+f.label+'</label>'+input+(f.note?'<div style="font-size:9px;color:#aaa;margin-top:2px;">'+f.note+'</div>':'')+'</div>';
    }).join('');
    return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">'+inner+'</div>';
  }

  function addRow(data){
    data=data||{};
    var idx=rows.length;
    rows.push(idx);
    var wrap=g(cfg.containerId); if(!wrap) return;
    var row=document.createElement('div');
    row.id='kc-row-'+idx;
    row.setAttribute('data-kc',idx);
    row.style.cssText='border:1px solid #e8e8e0;border-radius:8px;margin-bottom:8px;background:#fcfcfa;overflow:hidden;';

    // Promote button only if the host page supplied a handler.
    var promoteBtn = cfg.onPromote
      ? '<button onclick="KitBuilder._promote('+idx+')" style="padding:5px 11px;background:#eef7ee;border:1px solid #b0d8b0;border-radius:6px;font-size:11px;cursor:pointer;color:#1a7a1a;white-space:nowrap;">↑ Promote to SKU</button>'
      : '';

    row.innerHTML=
      '<div style="display:grid;grid-template-columns:2fr 70px auto auto;gap:8px;align-items:center;padding:10px;">'+
        '<div><label style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.04em;">Component</label>'+
          '<select id="kc-sku-'+idx+'" onchange="KitBuilder._skuChange('+idx+')" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;">'+skuOptions(data.component_sku_id)+'</select></div>'+
        '<div><label style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.04em;">Order Qty</label>'+
          '<input type="number" id="kc-qty-'+idx+'" value="'+(data.qty_per_kit||1)+'" step="1" min="1" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;" /></div>'+
        '<button onclick="KitBuilder._toggle('+idx+')" id="kc-toggle-'+idx+'" style="padding:6px 10px;background:#eef2ff;border:1px solid #c0d0f0;border-radius:6px;font-size:12px;cursor:pointer;color:#2244cc;white-space:nowrap;">Details ▾</button>'+
        '<button onclick="KitBuilder._remove('+idx+')" style="padding:6px 9px;background:#fce8e8;border:1px solid #f0d0d0;border-radius:6px;font-size:12px;cursor:pointer;color:#a22;">×</button>'+
      '</div>'+
      '<div id="kc-detail-'+idx+'" style="display:none;padding:0 10px 10px;border-top:1px solid #f0f0e8;">'+
        '<div id="kc-plain-'+idx+'" style="display:'+(data.component_sku_id?'none':'block')+';margin-top:10px;">'+
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'+
            '<div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:0.05em;">Product Details</div>'+
            promoteBtn+
          '</div>'+
          plainFieldsHtml(idx,data)+
        '</div>'+
        '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #e0e0d8;">'+
          '<div id="kc-catrow-'+idx+'" style="display:'+(data.component_sku_id?'none':'block')+';">'+
            '<div style="font-size:10px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Product Category</div>'+
            '<div style="margin-bottom:7px;"><label style="font-size:10px;color:#888;display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.04em;">Product Category</label>'+
              '<select id="kc-cat-'+idx+'" onchange="KitBuilder._warn()" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;">'+catOptions(data.category_id)+'</select></div>'+
          '</div>'+
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;align-items:center;">'+
            '<label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="kc-consumer-'+idx+'" '+(data.consumer_packaging?'checked':'')+' onchange="KitBuilder._warn()" /> Consumer pkg</label>'+
            '<label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="kc-inner-'+idx+'" '+(data.inner_carton?'checked':'')+' /> Inner carton</label>'+
            '<div><input type="number" id="kc-bulk-'+idx+'" value="'+(data.bulk_master_pack_qty||'')+'" placeholder="Bulk/master qty" step="1" style="width:100%;padding:5px 7px;font-size:11px;border:1px solid #e0e0d8;border-radius:6px;" /></div>'+
          '</div>'+
        '</div>'+
        // ── Per-component packaging mode: existing / new (→ variant) / bulk-naked ──
        '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #e0e0d8;">'+
          '<div style="font-size:10px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Component Packaging</div>'+
          '<select id="kc-pkgmode-'+idx+'" onchange="KitBuilder._pkgModeChange('+idx+')" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;">'+
            '<option value="existing"'+(data.pkg_mode==='existing'||!data.pkg_mode?' selected':'')+'>Existing packaging (use this SKU\u2019s packaging on file)</option>'+
            '<option value="new"'+(data.pkg_mode==='new'?' selected':'')+'>New packaging (creates a packaging variant of this SKU)</option>'+
            '<option value="bulk"'+(data.pkg_mode==='bulk'?' selected':'')+'>Bulk / naked (no packaging)</option>'+
          '</select>'+
          '<div id="kc-newpkg-'+idx+'" style="display:none;margin-top:8px;padding:8px;background:#f7f9ff;border:1px solid #d8e2f5;border-radius:6px;">'+
            '<div style="font-size:10px;color:#2244cc;font-weight:600;margin-bottom:8px;">New packaging — a child variant SKU (\u2011V#) will be created on save. Same product &amp; certs, new packaging + cost.</div>'+
            '<label style="font-size:10px;color:#888;display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.04em;">Primary container</label>'+
            '<div id="kc-np-primary-mount-'+idx+'"></div>'+
            '<label style="font-size:10px;color:#888;display:block;margin:8px 0 2px;text-transform:uppercase;letter-spacing:0.04em;">Closure / applicator</label>'+
            '<div id="kc-np-closure-mount-'+idx+'"></div>'+
            '<label style="font-size:10px;color:#888;display:block;margin:8px 0 2px;text-transform:uppercase;letter-spacing:0.04em;">Secondary / display</label>'+
            '<div id="kc-np-secondary-mount-'+idx+'"></div>'+
            '<input type="text" id="kc-np-artwork-'+idx+'" placeholder="Packaging artwork link (optional)" style="width:100%;margin-top:8px;padding:5px 7px;font-size:11px;border:1px solid #d8e2f5;border-radius:6px;" />'+
            '<textarea id="kc-np-notes-'+idx+'" rows="2" placeholder="Packaging notes (optional)" style="width:100%;margin-top:6px;padding:5px 7px;font-size:11px;border:1px solid #d8e2f5;border-radius:6px;resize:vertical;"></textarea>'+
          '</div>'+
        '</div>'+
      '</div>';
    wrap.appendChild(row);
    _pkgModeChange(idx);
    _warn();
  }

  // Show/hide the new-packaging sub-form; lazily build the SearchDropdowns once.
  function _pkgModeChange(idx){
    var mode=g('kc-pkgmode-'+idx)?g('kc-pkgmode-'+idx).value:'existing';
    var np=g('kc-newpkg-'+idx);
    if(np)np.style.display=(mode==='new')?'block':'none';
    if(mode==='new' && !pkgDD[idx]){
      pkgDD[idx]={
        primary:SearchDropdown.create({mountId:'kc-np-primary-mount-'+idx, options:cfg.pkgOptions.primary||[], multi:false, placeholder:"Click or type (e.g. 'glass', 'tube')..."}),
        closure:SearchDropdown.create({mountId:'kc-np-closure-mount-'+idx, options:cfg.pkgOptions.closure||[], multi:true, placeholder:"Click or type (e.g. 'pump', 'dropper')..."}),
        secondary:SearchDropdown.create({mountId:'kc-np-secondary-mount-'+idx, options:cfg.pkgOptions.secondary||[], multi:true, placeholder:"Click or type (e.g. 'carton', 'sleeve')..."})
      };
    }
  }

  function _toggle(idx){
    var d=g('kc-detail-'+idx),t=g('kc-toggle-'+idx);
    if(!d)return;
    var open=d.style.display==='none';
    d.style.display=open?'block':'none';
    if(t)t.innerHTML=open?'Details ▴':'Details ▾';
  }

  function _remove(idx){
    var row=g('kc-row-'+idx); if(row)row.remove();
    _warn();
  }

  function _skuChange(idx){
    var sku=g('kc-sku-'+idx).value;
    var p=g('kc-plain-'+idx);
    if(p)p.style.display=sku?'none':'block';
    // Existing SKU carries its own category — don't ask for it. Hide the category row.
    var catRow=g('kc-catrow-'+idx);
    if(catRow)catRow.style.display=sku?'none':'block';
    _warn();
  }

  function _promote(idx){
    if(cfg.onPromote) cfg.onPromote(idx);
  }

  function _warn(){
    if(!cfg.warningId) return;
    var warnEl=g(cfg.warningId); if(!warnEl)return;
    var nakedCosmetic=0, nakedHard=0;
    document.querySelectorAll('#'+cfg.containerId+' [data-kc]').forEach(function(row){
      var idx=row.getAttribute('data-kc');
      var consumerEl=g('kc-consumer-'+idx); if(!consumerEl)return;
      if(consumerEl.checked)return;
      var skuId=g('kc-sku-'+idx)?g('kc-sku-'+idx).value:'';
      var isCosmetic=false;
      if(skuId){
        var s=skus().find(function(x){return x.id===skuId;});
        isCosmetic=s&&s.categories&&s.categories.is_cosmetic;
      } else {
        var catId=g('kc-cat-'+idx)?g('kc-cat-'+idx).value:'';
        var c=cats().find(function(x){return x.id===catId;});
        isCosmetic=c&&c.is_cosmetic;
      }
      if(isCosmetic)nakedCosmetic++; else nakedHard++;
    });
    if(nakedCosmetic||nakedHard){
      var parts=[];
      if(nakedCosmetic)parts.push('<b>'+nakedCosmetic+' cosmetic component(s) shipping naked</b> — cannot be sold standalone if the kit is broken up without repackaging. Higher risk.');
      if(nakedHard)parts.push(nakedHard+' hard-line component(s) shipping naked — lower risk, but de-kitting would need repackaging.');
      warnEl.innerHTML='⚠ '+parts.join('<br>');
      warnEl.style.display='block';
    } else {
      warnEl.style.display='none';
    }
  }

  function collect(){
    var out=[];
    document.querySelectorAll('#'+cfg.containerId+' [data-kc]').forEach(function(row){
      var idx=row.getAttribute('data-kc');
      var skuId=g('kc-sku-'+idx)?g('kc-sku-'+idx).value:'';
      var plain={};
      FIELDS.forEach(function(f){
        var el=g('kc-'+f.key+'-'+idx);
        if(!el)return;
        var val=el.value;
        plain[f.key]=(f.type==='number')?(val?parseFloat(val):null):(val?val.trim():null);
      });
      var s=skuId?skus().find(function(x){return x.id===skuId;}):null;
      var pkgMode=g('kc-pkgmode-'+idx)?g('kc-pkgmode-'+idx).value:'existing';
      var newPkg=null;
      if(pkgMode==='new'){
        var dd=pkgDD[idx]||{};
        var prim=dd.primary?dd.primary.getSelected():null;
        var clo=dd.closure?dd.closure.getSelected():[];
        var sec=dd.secondary?dd.secondary.getSelected():[];
        newPkg={
          primary: prim||null,
          material: null,
          closure: (clo&&clo.length)?clo.join(', '):null,
          secondary: (sec&&sec.length)?sec.join(', '):null,
          artwork_url:g('kc-np-artwork-'+idx)?g('kc-np-artwork-'+idx).value.trim()||null:null,
          notes:g('kc-np-notes-'+idx)?g('kc-np-notes-'+idx).value.trim()||null:null
        };
      }
      out.push({
        component_sku_id:skuId||null,
        qty_per_kit:parseFloat(g('kc-qty-'+idx).value)||1,
        product_title:skuId?(s?s.description:null):plain.product_title,
        description:skuId?(s?(s.detailed_description||null):null):plain.description,
        size_volume:skuId?null:plain.size_volume,
        unit_l:skuId?null:plain.unit_l,
        unit_w:skuId?null:plain.unit_w,
        unit_h:skuId?null:plain.unit_h,
        unit_wt_g:skuId?null:plain.unit_wt_g,
        units_per_master:skuId?null:plain.units_per_master,
        category_id:skuId?null:(g('kc-cat-'+idx)?g('kc-cat-'+idx).value||null:null),
        reconcile_status:skuId?'matched':'unmatched',
        consumer_packaging:g('kc-consumer-'+idx)?g('kc-consumer-'+idx).checked:false,
        inner_carton:g('kc-inner-'+idx)?g('kc-inner-'+idx).checked:false,
        bulk_master_pack_qty:g('kc-bulk-'+idx)&&g('kc-bulk-'+idx).value?parseInt(g('kc-bulk-'+idx).value):null,
        unit_cost:plain.unit_cost,
        pkg_mode:pkgMode,
        new_packaging:newPkg
      });
    });
    return out;
  }

  return {
    init:init, reset:reset, addRow:addRow, collect:collect,
    populatePackaging:populatePackaging, FIELDS:FIELDS,
    rowCount:function(){return document.querySelectorAll('#'+cfg.containerId+' [data-kc]').length;},
    // internal handlers referenced by inline onclick:
    _toggle:_toggle, _remove:_remove, _skuChange:_skuChange, _promote:_promote, _warn:_warn, _pkgModeChange:_pkgModeChange
  };
})();


/* ════════════════════════════════════════════════════════════════════
   SearchDropdown — a clean, reusable searchable multi/single-select.
   Replaces the fragile inline-onmousedown packaging dropdowns. Proper
   event listeners, commits on click, stays open for multi-select, click
   anywhere outside closes it, and selections are changeable.

   Usage:
     var dd = SearchDropdown.create({
       mountId: 'some-div-id',        // empty container in your DOM
       options: [{value, group}, ...],// grouped options
       multi: true|false,
       placeholder: 'Click or type to filter...',
       initial: ['x'] or 'x',         // pre-selected
       onChange: function(selected){} // selected = array (multi) or string|null (single)
     });
     dd.getSelected();  dd.setSelected(v);  dd.destroy();
   ════════════════════════════════════════════════════════════════════ */
// ── Shared packaging option lists (used by SearchDropdown.PKG_OPTIONS) ──
var PKG_PRIMARY_OPTIONS = [
  // Glass
  { group:'Glass', value:'Glass bottle - round',                          material:'Glass' },
  { group:'Glass', value:'Glass bottle - boston round',                   material:'Glass' },
  { group:'Glass', value:'Glass bottle - square',                         material:'Glass' },
  { group:'Glass', value:'Glass bottle - cylindrical tall',               material:'Glass' },
  { group:'Glass', value:'Glass bottle - cylindrical short',              material:'Glass' },
  { group:'Glass', value:'Glass bottle - oval',                           material:'Glass' },
  { group:'Glass', value:'Glass bottle - dropper blank',                  material:'Glass' },
  { group:'Glass', value:'Glass jar - straight-sided',                    material:'Glass' },
  { group:'Glass', value:'Glass jar - low-profile cosmetic',              material:'Glass' },
  { group:'Glass', value:'Glass jar - tall cosmetic',                     material:'Glass' },
  { group:'Glass', value:'Glass jar - hexagonal',                         material:'Glass' },
  { group:'Glass', value:'Glass vial',                                    material:'Glass' },
  { group:'Glass', value:'Glass ampoule',                                 material:'Glass' },
  { group:'Glass', value:'Glass roll-on bottle',                          material:'Glass' },
  // Plastic — bottles
  { group:'Plastic', value:'Plastic bottle - PET round',                  material:'PET' },
  { group:'Plastic', value:'Plastic bottle - PET boston round',           material:'PET' },
  { group:'Plastic', value:'Plastic bottle - HDPE round',                 material:'HDPE' },
  { group:'Plastic', value:'Plastic bottle - HDPE oval',                  material:'HDPE' },
  { group:'Plastic', value:'Plastic bottle - PP',                         material:'PP' },
  { group:'Plastic', value:'Plastic bottle - PCR (post-consumer recycled)', material:'PCR' },
  { group:'Plastic', value:'Plastic bottle - airless',                    material:'PP' },
  { group:'Plastic', value:'Plastic bottle - dropper blank',              material:'Plastic' },
  // Plastic — jars
  { group:'Plastic', value:'Plastic jar - PET',                           material:'PET' },
  { group:'Plastic', value:'Plastic jar - PP',                            material:'PP' },
  { group:'Plastic', value:'Plastic jar - PCR',                           material:'PCR' },
  { group:'Plastic', value:'Plastic jar - airless',                       material:'PP' },
  // Plastic — vials, roll-ons, tubes, pouches
  { group:'Plastic', value:'Plastic vial',                                material:'Plastic' },
  { group:'Plastic', value:'Plastic roll-on bottle',                      material:'Plastic' },
  { group:'Plastic', value:'Squeeze tube - LDPE',                         material:'LDPE' },
  { group:'Plastic', value:'Squeeze tube - laminate (ABL)',               material:'Laminate' },
  { group:'Plastic', value:'Squeeze tube - aluminum-plastic laminate',    material:'Laminate' },
  { group:'Plastic', value:'Plastic pouch / sachet',                      material:'Plastic film' },
  { group:'Plastic', value:'Stand-up pouch (gusseted)',                   material:'Plastic film' },
  { group:'Plastic', value:'Spout pouch',                                 material:'Plastic film' },
  // Metal
  { group:'Metal', value:'Aluminum bottle',                               material:'Aluminum' },
  { group:'Metal', value:'Aluminum jar',                                  material:'Aluminum' },
  { group:'Metal', value:'Aluminum tin (round)',                          material:'Aluminum' },
  { group:'Metal', value:'Aluminum tin (rectangular)',                    material:'Aluminum' },
  { group:'Metal', value:'Aluminum aerosol can',                          material:'Aluminum' },
  { group:'Metal', value:'Steel aerosol can',                             material:'Steel' },
  { group:'Metal', value:'Tinplate tin',                                  material:'Tinplate' },
  { group:'Metal', value:'Aluminum collapsible tube',                     material:'Aluminum' },
  // Paper / Board
  { group:'Paper / Board', value:'Paperboard push-up tube (kraft)',       material:'Paperboard' },
  { group:'Paper / Board', value:'Cardboard box (primary)',               material:'Paperboard' },
  { group:'Paper / Board', value:'Compostable molded fiber container',    material:'Molded fiber' },
  // Specialty
  { group:'Specialty', value:'Compact (powder / cream)',                  material:'Mixed' },
  { group:'Specialty', value:'Stick container (chapstick-style)',         material:'Mixed' },
  { group:'Specialty', value:'Click-pen applicator',                      material:'Mixed' },
  { group:'Specialty', value:'Hot-pour stick mold',                       material:'Mixed' },
  // None / bulk
  { group:'No primary container', value:'Bulk / no individual primary container', material:'N/A' }
];

var PKG_CLOSURE_OPTIONS = [
  // Caps / Lids
  { group:'Caps / Lids', value:'Screw cap - smooth' },
  { group:'Caps / Lids', value:'Screw cap - ribbed' },
  { group:'Caps / Lids', value:'Screw cap - disc top / flip top' },
  { group:'Caps / Lids', value:'Screw cap - with built-in spatula' },
  { group:'Caps / Lids', value:'Snap cap' },
  { group:'Caps / Lids', value:'Hinged flip-top lid' },
  { group:'Caps / Lids', value:'Twist-up tube cap' },
  { group:'Caps / Lids', value:'Crimp seal (aluminum)' },
  { group:'Caps / Lids', value:'Cork stopper' },
  { group:'Caps / Lids', value:'T-top wood cap' },
  // Pumps
  { group:'Pumps', value:'Pump - lotion / cream' },
  { group:'Pumps', value:'Pump - foamer' },
  { group:'Pumps', value:'Pump - airless' },
  { group:'Pumps', value:'Pump - treatment (small dose)' },
  { group:'Pumps', value:'Pump - high-viscosity' },
  // Sprayers
  { group:'Sprayers', value:'Mist sprayer - fine mist' },
  { group:'Sprayers', value:'Mist sprayer - continuous (no propellant)' },
  { group:'Sprayers', value:'Trigger sprayer' },
  { group:'Sprayers', value:'Aerosol valve - continuous spray' },
  { group:'Sprayers', value:'Aerosol valve - metered dose' },
  // Dispensers / Spouts
  { group:'Dispensers / Spouts', value:'Orifice reducer' },
  { group:'Dispensers / Spouts', value:'Disc top / flip top spout' },
  { group:'Dispensers / Spouts', value:'Pour spout' },
  { group:'Dispensers / Spouts', value:'Yorker spout' },
  { group:'Dispensers / Spouts', value:'Twist-and-pour spout' },
  // Droppers
  { group:'Droppers', value:'Dropper - glass with rubber bulb' },
  { group:'Droppers', value:'Dropper - calibrated / graduated' },
  { group:'Droppers', value:'Dropper - plastic' },
  { group:'Droppers', value:'Dropper - pipette (drop-by-drop)' },
  // Applicators
  { group:'Applicators', value:'Roller ball' },
  { group:'Applicators', value:'Brush applicator (small)' },
  { group:'Applicators', value:'Brush applicator (wide)' },
  { group:'Applicators', value:'Wand applicator (mascara-style)' },
  { group:'Applicators', value:'Doe foot applicator (lip gloss)' },
  { group:'Applicators', value:'Spatula included (separate)' },
  { group:'Applicators', value:'Spoon included (separate)' },
  { group:'Applicators', value:'Cotton tip applicator' },
  { group:'Applicators', value:'Foam tip applicator' },
  { group:'Applicators', value:'Sponge applicator' },
  // Seals
  { group:'Seals', value:'Induction seal (foil)' },
  { group:'Seals', value:'Tamper-evident band' },
  { group:'Seals', value:'Pressure-sensitive seal' },
  // Other
  { group:'Other', value:'Twist-up mechanism (stick products)' },
  { group:'Other', value:'Click mechanism' },
  { group:'Other', value:'None / bulk (no closure)' }
];

var PKG_SECONDARY_OPTIONS = [
  // Boxes
  { group:'Boxes', value:'Paper folding carton (mono-material)' },
  { group:'Boxes', value:'Paper folding carton (with insert)' },
  { group:'Boxes', value:'Paper folding carton (with window cutout)' },
  { group:'Boxes', value:'Rigid box / set-up box' },
  { group:'Boxes', value:'Mailer box (corrugated)' },
  { group:'Boxes', value:'Sleeve box' },
  // Blister / Card
  { group:'Blister / Card', value:'Blister pack (carded)' },
  { group:'Blister / Card', value:'Clamshell' },
  { group:'Blister / Card', value:'Skin pack' },
  { group:'Blister / Card', value:'Slide card' },
  // Wrapping / Sealing
  { group:'Wrapping / Sealing', value:'Shrink sleeve (decorative full-body)' },
  { group:'Wrapping / Sealing', value:'Shrink wrap (clear protective)' },
  { group:'Wrapping / Sealing', value:'Belly band / paper sleeve' },
  { group:'Wrapping / Sealing', value:'Pillow pack / flow wrap' },
  // Hang / Display
  { group:'Hang / Display', value:'Hang tag (paper)' },
  { group:'Hang / Display', value:'Hang tag (plastic clip)' },
  { group:'Hang / Display', value:'Pouch with hang hole / Eurohole' },
  { group:'Hang / Display', value:'Display tray' },
  { group:'Hang / Display', value:'Counter display (PDQ)' },
  { group:'Hang / Display', value:'Floor display unit' },
  // None
  { group:'None', value:'Naked (no secondary packaging)' },
  { group:'None', value:'Bulk shipper only' }
];

var PKG_DECORATION_OPTIONS = [
  { group:'Direct on package', value:'Silkscreen print' },
  { group:'Direct on package', value:'Pad print' },
  { group:'Direct on package', value:'Direct digital print' },
  { group:'Direct on package', value:'Hot stamp' },
  { group:'Direct on package', value:'Foil stamp' },
  { group:'Direct on package', value:'Embossing' },
  { group:'Direct on package', value:'Debossing' },
  { group:'Direct on package', value:'Spot UV' },
  { group:'Direct on package', value:'Frosting / etching' },
  { group:'Labels', value:'Paper label' },
  { group:'Labels', value:'Clear label' },
  { group:'Labels', value:'Metallized label' },
  { group:'Labels', value:'Textured / specialty label' },
  { group:'Sleeves', value:'Shrink sleeve (decorative)' },
  { group:'None', value:'No decoration' }
];

var PKG_SUSTAINABILITY_OPTIONS = [
  { group:'Recycled content', value:'PCR 25%+ (post-consumer recycled)' },
  { group:'Recycled content', value:'PCR 50%+' },
  { group:'Recycled content', value:'PCR 100%' },
  { group:'Certifications', value:'FSC certified board' },
  { group:'Certifications', value:'How2Recycle label compliant' },
  { group:'Design', value:'Recyclable (single-material)' },
  { group:'Design', value:'Refillable design' },
  { group:'Design', value:'Lightweighted (reduced plastic)' },
  { group:'Biodegradable / Compostable', value:'Biodegradable' },
  { group:'Biodegradable / Compostable', value:'Industrially compostable' },
  { group:'Biodegradable / Compostable', value:'Home compostable' },
  { group:'Alternative materials', value:'Bio-based plastic (PE/PET)' },
  { group:'Alternative materials', value:'Aluminum-free / plastic-free' }
];


var SearchDropdown = (function(){
  try{console.log('kit-builder.js build: KB-2026-05-25-C');}catch(e){}
  var instances = [];
  var idSeq = 0;

  function esc(s){if(s==null)return '';return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

  function create(opts){
    var id = 'sd-'+(++idSeq);
    var mount = document.getElementById(opts.mountId);
    if(!mount) return null;
    var multi = !!opts.multi;
    var selected = multi
      ? (Array.isArray(opts.initial)?opts.initial.slice():[])
      : (opts.initial||null);

    mount.innerHTML =
      '<div class="sd-wrap" style="position:relative;">'+
        '<input type="text" class="sd-input" placeholder="'+esc(opts.placeholder||'Click or type to filter...')+'" autocomplete="off" '+
          'style="width:100%;padding:8px 10px;border:1px solid #d0d0c8;border-radius:6px;font-family:inherit;font-size:13px;box-sizing:border-box;" />'+
        '<div class="sd-menu" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #d0d0c8;border-top:none;border-radius:0 0 6px 6px;max-height:280px;overflow-y:auto;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.10);"></div>'+
        '<div class="sd-chips" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px;"></div>'+
      '</div>';

    var input = mount.querySelector('.sd-input');
    var menu  = mount.querySelector('.sd-menu');
    var chips = mount.querySelector('.sd-chips');

    function isSel(v){ return multi ? selected.indexOf(v)>=0 : selected===v; }

    function renderMenu(filter){
      var q=(filter||'').toLowerCase().trim();
      var list=opts.options.filter(function(o){
        return !q || o.value.toLowerCase().indexOf(q)>=0 || (o.group||'').toLowerCase().indexOf(q)>=0;
      });
      if(!list.length){ menu.innerHTML='<div style="padding:10px;font-size:12px;color:#888;font-style:italic;">No matches</div>'; return; }
      var groups={}, order=[];
      list.forEach(function(o){var gp=o.group||'Other'; if(!groups[gp]){groups[gp]=[];order.push(gp);} groups[gp].push(o);});
      menu.innerHTML=order.map(function(gp){
        return '<div style="padding:6px 10px;font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.06em;background:#fafaf6;border-bottom:1px solid #f0f0e8;">'+esc(gp)+'</div>'+
          groups[gp].map(function(o){
            var sel=isSel(o.value);
            return '<div class="sd-opt" data-val="'+esc(o.value)+'" style="padding:7px 10px;font-size:12px;color:#1a1a2e;cursor:pointer;background:'+(sel?'#edfaed':'#fff')+';border-bottom:1px solid #f5f5f0;">'+
              (sel?'<span style="color:#1a7a1a;font-weight:700;margin-right:6px;">✓</span>':'<span style="display:inline-block;width:14px;"></span>')+esc(o.value)+'</div>';
          }).join('');
      }).join('');
    }

    function renderChips(){
      var arr = multi ? selected : (selected?[selected]:[]);
      chips.innerHTML = arr.map(function(v){
        return '<span style="display:inline-flex;align-items:center;gap:5px;background:#eef2ff;color:#2244cc;border-radius:14px;padding:3px 10px;font-size:12px;">'+esc(v)+
          '<span class="sd-chip-x" data-val="'+esc(v)+'" style="cursor:pointer;font-weight:700;">×</span></span>';
      }).join('');
    }

    function open(){ renderMenu(input.value); menu.style.display='block'; }
    function close(){ menu.style.display='none'; }

    function commit(v){
      if(multi){
        var i=selected.indexOf(v);
        if(i>=0) selected.splice(i,1); else selected.push(v);
        renderChips(); renderMenu(input.value); // stay open, update checks
      } else {
        selected=v; renderChips(); input.value=''; close();
      }
      if(opts.onChange) opts.onChange(multi?selected.slice():selected);
    }

    function removeChip(v){
      if(multi){ var i=selected.indexOf(v); if(i>=0)selected.splice(i,1); }
      else { selected=null; }
      renderChips(); renderMenu(input.value);
      if(opts.onChange) opts.onChange(multi?selected.slice():selected);
    }

    // ── Proper event listeners (no inline preventDefault/blur fighting) ──
    input.addEventListener('focus', open);
    input.addEventListener('click', function(e){ e.stopPropagation(); open(); });
    input.addEventListener('input', function(){ open(); });
    input.addEventListener('keydown', function(e){ if(e.key==='Escape'){ close(); input.blur(); } });

    var clickedInside=false;
    menu.addEventListener('mousedown', function(e){
      clickedInside=true;
      var opt=e.target.closest('.sd-opt');
      if(opt){ e.preventDefault(); e.stopPropagation(); commit(opt.getAttribute('data-val')); }
    });
    chips.addEventListener('mousedown', function(e){
      clickedInside=true;
      var x=e.target.closest('.sd-chip-x');
      if(x){ e.preventDefault(); e.stopPropagation(); removeChip(x.getAttribute('data-val')); }
    });
    mount.addEventListener('mousedown', function(){ clickedInside=true; });

    // Outside click closes. clickedInside is set at mousedown (before any
    // re-render), so a re-rendered/removed target can't fool the check.
    var outside=function(e){
      if(clickedInside){ clickedInside=false; return; }
      close();
    };
    document.addEventListener('click', outside);

    renderChips();

    var api={
      getSelected:function(){ return multi?selected.slice():selected; },
      setSelected:function(v){ selected = multi?(Array.isArray(v)?v.slice():[]):v; renderChips(); },
      destroy:function(){ document.removeEventListener('click', outside); mount.innerHTML=''; }
    };
    instances.push(api);
    return api;
  }

  return { create:create,
    PKG_OPTIONS:{
      primary:(typeof PKG_PRIMARY_OPTIONS!=='undefined')?PKG_PRIMARY_OPTIONS:[],
      closure:(typeof PKG_CLOSURE_OPTIONS!=='undefined')?PKG_CLOSURE_OPTIONS:[],
      secondary:(typeof PKG_SECONDARY_OPTIONS!=='undefined')?PKG_SECONDARY_OPTIONS:[],
      decoration:(typeof PKG_DECORATION_OPTIONS!=='undefined')?PKG_DECORATION_OPTIONS:[],
      sustainability:(typeof PKG_SUSTAINABILITY_OPTIONS!=='undefined')?PKG_SUSTAINABILITY_OPTIONS:[]
    }
  };
})();
