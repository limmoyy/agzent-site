(function(){
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // scroll reveal
  var io = new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
  },{threshold:.12, rootMargin:'0px 0px -40px 0px'});
  document.querySelectorAll('[data-r]').forEach(function(el){ io.observe(el); });

  // animated order flow
  var steps = document.querySelectorAll('.fs'), bar = document.getElementById('bar'), k = 0;
  function tick(){
    steps.forEach(function(s,i){ s.classList.toggle('on', i===k); s.classList.toggle('done', i<k); });
    bar.style.width = ((k+1)/steps.length*100)+'%';
    k = (k+1) % steps.length;
  }
  tick(); if(!reduce) setInterval(tick, 1700);

  if(!reduce && matchMedia('(pointer:fine)').matches){
    // card tilt
    document.querySelectorAll('.tilt').forEach(function(c){
      c.addEventListener('mousemove',function(e){
        var r=c.getBoundingClientRect(), x=(e.clientX-r.left)/r.width-.5, y=(e.clientY-r.top)/r.height-.5;
        c.style.transform='perspective(900px) rotateX('+(-y*7)+'deg) rotateY('+(x*7)+'deg) translateY(-4px)';
      });
      c.addEventListener('mouseleave',function(){ c.style.transform=''; });
    });
    // hero blobs drift with scroll
    var blobs=document.querySelectorAll('.hero .blob');
    addEventListener('scroll',function(){
      var y=scrollY; blobs.forEach(function(b,i){ b.style.translate='0 '+(y*(.08+i*.05))+'px'; });
    },{passive:true});
  }

  // package preselect + mailto form
  document.querySelectorAll('[data-paket]').forEach(function(a){
    a.addEventListener('click',function(){ document.getElementById('paket').value=a.dataset.paket; });
  });
  document.getElementById('f').addEventListener('submit',function(e){
    e.preventDefault();
    var d=new FormData(this);
    if(!d.get('nama')||!d.get('email')){ alert('Please fill in your name and email.'); return; }
    var subj='Odoo consultation — '+(d.get('perusahaan')||d.get('nama'));
    var body='Name: '+d.get('nama')+'\nCompany: '+(d.get('perusahaan')||'-')+'\nEmail: '+d.get('email')+
      '\nPackage: '+d.get('paket')+'\n\nNeeds:\n'+(d.get('pesan')||'-');
    location.href='mailto:ags@agzent.my.id?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(body);
  });
})();
