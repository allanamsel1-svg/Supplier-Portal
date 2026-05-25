/* ════════════════════════════════════════════════════════════════════
   kit-builder.js — SHARED kit-component builder
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
    rows = [];
  }

  function reset(){
    rows = [];
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
    var inner=FIELDS.map(function(f){
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
          '<div style="font-size:10px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Admin · category &amp; kit packaging</div>'+
          '<div style="margin-bottom:7px;"><label style="font-size:10px;color:#888;display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.04em;">Category</label>'+
            '<select id="kc-cat-'+idx+'" onchange="KitBuilder._warn()" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #e0e0d8;border-radius:6px;">'+catOptions(data.category_id)+'</select></div>'+
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;align-items:center;">'+
            '<label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="kc-consumer-'+idx+'" '+(data.consumer_packaging?'checked':'')+' onchange="KitBuilder._warn()" /> Consumer pkg</label>'+
            '<label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="kc-inner-'+idx+'" '+(data.inner_carton?'checked':'')+' /> Inner carton</label>'+
            '<div><input type="number" id="kc-bulk-'+idx+'" value="'+(data.bulk_master_pack_qty||'')+'" placeholder="Bulk/master qty" step="1" style="width:100%;padding:5px 7px;font-size:11px;border:1px solid #e0e0d8;border-radius:6px;" /></div>'+
          '</div>'+
        '</div>'+
      '</div>';
    wrap.appendChild(row);
    _warn();
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
        unit_cost:plain.unit_cost
      });
    });
    return out;
  }

  return {
    init:init, reset:reset, addRow:addRow, collect:collect,
    populatePackaging:populatePackaging, FIELDS:FIELDS,
    rowCount:function(){return document.querySelectorAll('#'+cfg.containerId+' [data-kc]').length;},
    // internal handlers referenced by inline onclick:
    _toggle:_toggle, _remove:_remove, _skuChange:_skuChange, _promote:_promote, _warn:_warn
  };
})();
