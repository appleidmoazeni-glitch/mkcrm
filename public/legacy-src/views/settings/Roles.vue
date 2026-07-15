<template>
  <main class="main-content">
    <div class="row">
      <div class="col-lg-7">
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <h5>لیست دسترسی های <span class="text-primary">{{groups.length>0 ? `[${groups[selectedGroup]['title']}]` : ""}}</span></h5>
            <span v-if="rLoading"><i class="fa fa-refresh text-muted fa-spin"></i></span>
          </div>
          <b-overlay :show="pLoading" opacity="0.6" rounded="lg" class="card-body">
            <div class="dd" id="nestable1">
              <ol class="dd-list"></ol>
            </div>
          </b-overlay>
        </div>
      </div>
      <div class="col-lg-5">
        <div class="card">
          <div class="card-header"><h5>گروه‌های کاربری</h5></div>
          <b-overlay :show="gLoading" opacity="0.6" rounded="lg" class="card-body">
            <button v-for="(group, index) of groups" @click="setActiveGroup(index)" :class="['btn w-100 mb-1 d-flex justify-content-between', (selectedGroup==index?'btn-primary':'btn-light')]"><span>{{ group.title }}</span><span class="text-muted">{{ group.key }}</span></button>
          </b-overlay>
        </div>
        <input type="hidden" id="roleReload">
        <input type="hidden" id="nestable-output">
      </div>
    </div>
  </main>
</template>

<script>
import "../../../public/vendors/nestable/jquery.nestable.rtl";
import axios from "axios";
export default {
  data(){
    return {
      pLoading: false,
      gLoading: false,
      erLoading: false,
      rLoading: false,
      items: "",
      rules: [],
      groups: [],
      roles: {},
      selectedGroup: 0,
      mainRules: []
    }
  },
  methods:{
    async getRules(){
      let vm = this;
      this.pLoading = true;
      this.roles = {};
      let roles = (await axios.get('/admin/settings/roles.r', {params:{active:1, group: (vm.groups[vm.selectedGroup] ? vm.groups[vm.selectedGroup].key : "")}})).data.roles || [];
      for (let role of roles){
        this.roles[role.id] = role.mod;
      }
      let permissions = (await axios.get('/admin/settings/permission.r')).data;
      if( permissions.ok ){
        this.mainRules = [];
        this.rules = permissions.rules.filter((e) => {
          let isMain = !isNaN(e.parent);
          delete e.parent;

          if( isMain ){
            this.mainRules.push( e )
          }

          return e;
        });
      }else{
        toastr['error']("خطای ناشناخته");
      }
      this.pLoading = false;
    },
    getGroupsList(){
      this.gLoading = true;
      axios.get('/admin/settings/groups.r', {params:{active:1}}).then(({data}) => {
        this.groups = data.groups;
        this.gLoading = false;
      });
    },
    setActiveGroup(index){
      this.selectedGroup = index;
    }
  },
  async created() {
    let vm = this;
    this.getGroupsList();
    await this.getRules();
    var obj,output;

    function buildItem(item) {
      var html = `<li class="dd-item dd3-item" data-id="${item._id}" data-title="${item.title}">`;
      html += `<div class="dd-handle dd3-handle"><i class="fa ${item.type == 'menu' ? 'fa-bars' : (item.type == 'primary' ? 'fa-globe' : 'fa-cubes')} text-white"></i></div>
            <div class="dd3-content">
                <div class="d-flex justify-content-between">
                    <span>${item.title}</span>
                    <div class="align-middle">
                        ${item.type == 'primary' ? '<a href="#" data-toggle="rule-edit"><i class="fa fa-pencil '+((vm.roles[item._id] && vm.roles[item._id]=="w")?"text-success":"text-danger")+'"></i></a>' : ''}
                        <a href="#" data-toggle="rule-show"><i class="fa fa-eye ${vm.roles[item._id]?"text-success":"text-danger"}"></i></a>
                    </div>
                </div>
            </div>`;

      if (item.children) {
        html += `<ol class="dd-list">`;
        $.each(item.children, function (index, sub) {
          html += buildItem(sub);
        });
        html += `</ol>`;
      }

      html += "</li>";
      return html;
    }
    function updateItems(){

      obj = JSON.stringify(vm.rules);
      output = '';

      $.each(JSON.parse(obj), function (index, item) {
        output += buildItem(item);
      });
      $('#nestable1 .dd-list').html(output);

    }

    $(function () {
      updateItems();

      $('#nestable1 .dd-list').on('click', "[data-toggle^=rule-]", function (){
        var li = $(this).parents('.dd-item.dd3-item');
        var mod = $(this).data('toggle') == "rule-edit" ? "w" : "r";

        var aw = $(this).parent().children('[data-toggle="rule-edit"]').children('i');
        var ar = $(this).parent().children('[data-toggle="rule-show"]').children('i');

        vm.rLoading = true;
        axios.post('/admin/settings/roles.r', {mod: mod, rule: li.data('id'), group: vm.groups[vm.selectedGroup].key}).then(({data}) => {
          if( data.ok ){
            var w = aw.hasClass('text-success');
            var r = ar.hasClass('text-success');

            if( (r || w) && mod == 'r' ){
              aw.removeClass('text-success').addClass('text-danger');
              ar.removeClass('text-success').addClass('text-danger');
            }else if( w && mod == 'w' ){
              aw.removeClass('text-success').addClass('text-danger');
              ar.removeClass('text-danger').addClass('text-success');
            }else{
              if( mod == 'w' ){
                aw.removeClass('text-danger').addClass('text-success');
                ar.removeClass('text-danger').addClass('text-success');
              }else{
                aw.removeClass('text-success').addClass('text-danger');
                ar.removeClass('text-danger').addClass('text-success');
              }
            }
          }
          vm.rLoading = false;
        });
        return false;
      });
      $("#roleReload").click(async function(){
        await vm.getRules();
        updateItems();
      });
    });
  },
  watch: {
    selectedGroup: {
      handler(){
        $("#roleReload").click();
      }
    }
  }
}
</script>

<style scoped>
@import "../../../public/vendors/nestable/nestable.css";
.align-middle a{
  margin-right: 4px;
}
.btn-save{padding: 6px 12px;}
textarea[name=rule]{font-family: Tahoma}
.card-header .fa-refresh{font-size: 17px; margin-top: 5px;}
</style>
