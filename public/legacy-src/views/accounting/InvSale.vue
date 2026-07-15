<template>
  <main class="main-content full-height fh-custom">
    <div class="card">
      <div class="card-header bg-danger-bright d-flex justify-content-between">
        <h5>فاکتورهای فروش</h5>
        <div class="btns form-inline">
          <button :class="['form-control btn ml-1', dates==90?'btn-danger':'']" @click="dates = 90;">۹۰ روز گذشته</button>
          <button :class="['form-control btn ml-1', dates==30?'btn-danger':'']" @click="dates = 30;">۳۰ روز گذشته</button>
          <button :class="['form-control btn', dates==7?'btn-danger':'']" @click="dates = 7;">۷ روز گذشته</button>
        </div>
      </div>
      <div class="card-header p-0">
        <div class="row p-l-r-25">
          <div class="col-lg-6 col-md-12">
            <div :class="['form-group', access?'':'d-none']">
              <label class="col-form-label">مشتری:</label>
              <select id="AccountName" data-module="select2" name="AccountName"></select>
            </div>
            <div :class="['form-group mt-4', access?'d-none':'']">
              <label class="col-form-label">نام مشتری:</label>
              <select id="AccountNumber" data-module="select2">
                <template v-if="accessData">
                  <option :value="accessData.AccountNumber">{{ accessData.AccountName }}</option>
                  <option :value="accessData.SAccountNumber">{{ accessData.SAccountName }}</option>
                  <option v-for="exAcc of accessData.ExAccounts" :value="exAcc.AccountNumber">{{ exAcc.AccountName }}</option>
                </template>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div class="card-body p-0">
        <div class="card-scroll h-100">
          <b-skeleton-table v-if="!listLoaded" :rows="1" :columns="3" :table-props="{ bordered: true, striped: true }"></b-skeleton-table>
          <div v-else class="table-responsive">
            <table class="table table-hover">
              <thead>
              <tr>
                <th width="90">نوع فاکتور</th>
                <th width="90">شماره فاکتور</th>
                <th width="90">تاریخ فاکتور</th>
                <th>مشتری/فروشنده</th>
                <th width="90">رفرنس</th>
                <th width="70">تیک</th>
                <th width="70">چاپ</th>
                <th width="70"></th>
              </tr>
              </thead>
              <tbody>
              <tr v-for="(inv, index) of invHeaders">
                <td>فاکتور فروش</td>
                <td>{{inv.InvNo}}</td>
                <td>{{new Date(inv.InvDate).echoFa("Y/m/d")}}</td>
                <td>{{inv.AccountName}}</td>
                <td>{{inv.GeneralRef}}</td>
                <td><i v-if="inv.tick" class="fa fa-check-circle fa-large text-success"></i><span v-else>-</span></td>
                <td><i v-if="inv.printed" class="fa fa-check-circle fa-large text-success"></i><span v-else>-</span></td>
                <td>
                  <button class="btn btn-info btn-xs" data-toggle="modal" :data-index="index" data-target="#showInv">مشاهده</button>
                </td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <modal-inv :invHeaders="invHeaders" invType="sale" />
  </main>
</template>

<script>
import axios from "axios";
import ModalInv from "../../components/ModalInv";
export default {
  data(){
    return {
      invHeaders: [],
      listLoaded: false,
      dates: 7,
      dateStart: new Date(Date.now() - (86400000*(7))),
      dateEnd: new Date(),
      access: false,
      accessData: null,
    }
  },
  methods:{
    getInvHeaders(user=null){
      this.listLoaded = false;
      let dataSet = {type: 2, dateStart: this.dateStart.echo('Y/m/d'), dateEnd: this.dateEnd.echo('Y/m/d')};
      if( user ) dataSet['user'] = user;
      axios.post('/admin/accounting/getInvHeaderList', dataSet).then(({data}) => {
        if( data && data.ok ){
          this.invHeaders = data.list;
          this.listLoaded = true;

          this.$nextTick(function () {
            var ChatDiv = $('.card-scroll');
            var height = ChatDiv[0].scrollHeight;
            ChatDiv.scrollTop(height);
          });
        }else{
          toastr['error']("خطا در بارگذاری فاکتور ها");
        }
      });
    },
    getAccessData(){
      axios.post('/admin/accounting/accAccessList', {user: 1}).then(({data}) => {
        if( data.ok ){
          this.accessData = data.list.length > 0 ? data.list[0] : null;

          if( !this.access ){
            if( this.accessData ){
              this.getInvHeaders(this.accessData['AccountNumber']);
            }
          }else{
            this.getInvHeaders();
          }

        }else{
          toastr['error']("خطا در خواندن سطح دسترسی.");
        }
      });
    }
  },
  created() {
    axios.post('/admin/access', {rule: ">/accounting/invsale;"}).then(({data}) => {
      if( data.ok ){
        this.access = data.access;
      }
    })
  },
  mounted() {
    const vm = this;
    this.getAccessData();

    $(document).ready(function(){
      $('#AccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#AccountName').on('select2:select', function (e) {
        var data = e.params.data;
        vm.getInvHeaders(data.id);
      });

      $('#AccountNumber').on('select2:select', function (e) {
        var data = e.params.data;
        console.log(data.id)
        vm.getInvHeaders(data.id);
      });
    });
  },
  watch:{
    dates: {
      handler: function (value){
        this.dateStart = new Date(Date.now() - (86400000*(value)));
        const accNumber = $("#AccountName").val();
        if( accNumber ){
          this.getInvHeaders(accNumber);
        }else{
          this.getInvHeaders();
        }
      }
    }
  },
  components: {
    'modal-inv' : ModalInv
  }
}
</script>

<style scoped>
.full-height.fh-custom .card .card-body {height: calc(100vh - 245px);}
.fa-large{font-size: 20px;cursor: pointer;}
.btn-xs {padding: 2px 5px;font-size: 11px;height: 21px;}
</style>
