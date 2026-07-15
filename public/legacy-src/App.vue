<template>
  <admin-panel v-if="showPanel">
    <router-view />
  </admin-panel>
  <router-view v-else />
</template>
<script>
import './assets/css/main.css';
import 'bootstrap-vue/dist/bootstrap-vue.css';
import {mapState} from 'vuex';
import axios from 'axios';
import Panel from './views/panel/Panel';

export default {
  components: {
    'admin-panel': Panel
  },
  computed: {
    ...mapState(['showPanel'])
  },
  created() {
    const menuType = localStorage.getItem('menu-type');
    if( menuType ){
      document.querySelector("body").classList.add(menuType);
    }
    if( localStorage.getItem('night-mode') ){
      document.querySelector("body").classList.add('dark');
    }
  },
  async mounted(){
    if( this.$router.history._startLocation != "/login" ){
      let loginResponse = await axios.post("/admin/getUserInfo");
      this.$store.state.user = loginResponse.data.userData;
      socket.emit('join', loginResponse.data.userData.id);
    }
  },
  updated(){


    $("[data-module='select2']").each(function(){
      let config = {};
      if( $(this).data('placeholder') ){
        config.placeholder = $(this).data('placeholder');
      }
      $(this).select2(config);
    });

    $('[data-backround-image]').each(function (e) {
      $(this).css("background", 'url(' + $(this).data('backround-image') + ')');
    });

    $('.modal-vc').on('show.bs.modal', function (event) {
      var button = $(event.relatedTarget),
          modal = $(this),
          vars = modal.data('vars').replace(/ /g, ""),
          btn_id = button.data('id'),
          source = btn_id ? button.parents('.modal-vc-source[data-id='+btn_id+']') : button.parents('.modal-vc-source');
      vars = vars.split(',');
      for( var i in vars ){
        var dt_e = source.find("[data-var^='"+vars[i]+":']"),
            dt_v = dt_e.data('var');
        if( typeof dt_v != "undefined" ){
          dt_v = dt_v.split(':');
          switch (dt_v[1]) {
            case 'text': dt_v = dt_e.text(); break;
            case 'html': dt_v = dt_e.html(); break;
            case 'val': dt_v = dt_e.val(); break;
            case 'data': dt_v = dt_e.data('value'); break;
          }

          var md_e = modal.find("[data-var^='"+vars[i]+":']");
          for(var mi = 0; mi < md_e.length; mi++){
            var md_v = $(md_e[mi]).data('var');
            if( typeof md_v != "undefined" ) {
              md_v = md_v.split(':');
              switch (md_v[1]) {
                case 'text':$(md_e[mi]).text(dt_v);break;
                case 'html':$(md_e[mi]).html(dt_v);break;
                case 'val':$(md_e[mi]).val(dt_v);break;
                case 'sw':$(md_e[mi]).prop('checked', !!dt_v);break;
              }
            }
          }
        }
      }
    });
  }
}
</script>
